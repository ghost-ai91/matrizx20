use anchor_lang::prelude::*;
use anchor_lang::solana_program::{self, clock::Clock};
use anchor_spl::token::{self, Token, TokenAccount};
use anchor_spl::associated_token::AssociatedToken;
use chainlink_solana as chainlink;
use solana_program::program_pack::Pack;
#[cfg(not(feature = "no-entrypoint"))]
use {solana_security_txt::security_txt};


declare_id!("2SGUTp3c4oNUpTdsr1nEfp2j96VEyFVfQLqK7kNukHGk");

#[cfg(not(feature = "no-entrypoint"))]
security_txt! {
    name: "Referral Matrix System",
    project_url: "https://matrix.matrix",
    contacts: "email:01010101@matrix.io,discord:01010101,whatsapp:+55123456789",
    policy: "https://github.com/ghost-ai91/matrixv10/blob/main/SECURITY.md",
    preferred_languages: "en",
    source_code: "https://github.com/ghost-ai91/matrixv10/blob/main/programs/matrix-system/src/lib.rs",
    source_revision: env!("GITHUB_SHA", "unknown-revision"),
    source_release: env!("PROGRAM_VERSION", "unknown-version"),
    encryption: "",
    auditors: "",
    acknowledgements: "We thank all security researchers who contributed to the security of our protocol."
}

// Minimum deposit amount in USD (10 dollars in base units - 8 decimals)
const MINIMUM_USD_DEPOSIT: u64 = 10_00000000; // 10 USD with 8 decimals (Chainlink format)

// Maximum price feed staleness (24 hours in seconds)
const MAX_PRICE_FEED_AGE: i64 = 86400;

// Default SOL price in case of stale feed ($100 USD per SOL)
const DEFAULT_SOL_PRICE: i128 = 100_00000000; // $100 with 8 decimals

// Maximum number of upline accounts that can be processed in a single transaction
const MAX_UPLINE_DEPTH: usize = 6;

// Number of Vault A accounts in the remaining_accounts
const VAULT_A_ACCOUNTS_COUNT: usize = 3;

// Constants for strict address verification
pub mod verified_addresses {
    use solana_program::pubkey::Pubkey;

    // Vault A addresses 
    pub static A_VAULT_LP: Pubkey = solana_program::pubkey!("BGh2tc4kagmEmVvaogdcAodVDvUxmXWivYL5kxwapm31");
    pub static A_VAULT_LP_MINT: Pubkey = solana_program::pubkey!("Bk33KwVZ8hsgr3uSb8GGNJZpAEqH488oYPvoY5W9djVP");
    pub static A_TOKEN_VAULT: Pubkey = solana_program::pubkey!("HoASBFustFYysd9aCu6M3G3kve88j22LAyTpvCNp5J65");
    
    // Meteora pool addresses
    pub static POOL_ADDRESS: Pubkey = solana_program::pubkey!("BEuzx33ecm4rtgjtB2bShqGco4zMkdr6ioyzPh6vY9ot");
    pub static B_VAULT_LP: Pubkey = solana_program::pubkey!("8mNjx5Aww9DX33uFxZwqb7m2vhsavrxyzkME3hE63sT2");
    
    // Token and oracle addresses
    pub static TOKEN_MINT: Pubkey = solana_program::pubkey!("51JpoNC5es8mpeRhPfTPcqMFzFhxeW3UrfvTmFnbw5G1");
    pub static WSOL_MINT: Pubkey = solana_program::pubkey!("So11111111111111111111111111111111111111112");
    
    // Chainlink addresses (Devnet)
    pub static CHAINLINK_PROGRAM: Pubkey = solana_program::pubkey!("HEvSKofvBgfaexv23kMabbYqxasxU3mQ4ibBMEmJWHny");
    pub static SOL_USD_FEED: Pubkey = solana_program::pubkey!("99B2bTijsU6f1GCT73HmdR7HCFFjGMBcPZY6jZ96ynrR");

    //Multisig treasury
    pub static MULTISIG_TREASURY: Pubkey = solana_program::pubkey!("Eu22Js2qTu5bCr2WFY2APbvhDqAhUZpkYKmVsfeyqR2N");

}

// Program state structure
#[account]
pub struct ProgramState {
    pub owner: Pubkey,
    pub multisig_treasury: Pubkey,
    pub next_upline_id: u32,
    pub next_chain_id: u32,
}

impl ProgramState {
    pub const SIZE: usize = 32 + 32 + 4 + 4; // owner + multisig_treasury + next_upline_id + next_chain_id
}

// Structure to store complete information for each upline
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Default, Debug)]
pub struct UplineEntry {
    pub pda: Pubkey,       // PDA of the user account
    pub wallet: Pubkey,    // Original user wallet
}

// Referral upline structure
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Default)]
pub struct ReferralUpline {
    pub id: u32,
    pub depth: u8,
    pub upline: Vec<UplineEntry>, // Stores UplineEntry with all information
}

// Referral matrix structure
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Default)]
pub struct ReferralChain {
    pub id: u32,
    pub slots: [Option<Pubkey>; 3],
    pub filled_slots: u8,
}

// User account structure
#[account]
#[derive(Default)]
pub struct UserAccount {
    pub is_registered: bool,
    pub referrer: Option<Pubkey>,
    pub owner_wallet: Pubkey,           // Account owner's wallet
    pub upline: ReferralUpline,
    pub chain: ReferralChain,
    pub reserved_sol: u64,       // SOL reserved from the second slot
    pub reserved_tokens: u64,    // Tokens reserved from the second slot
}

impl UserAccount {
    pub const SIZE: usize = 1 + // is_registered
                           1 + 32 + // Option<Pubkey> (1 for is_some + 32 for Pubkey)
                           32 + // owner_wallet
                           4 + 1 + 4 + (MAX_UPLINE_DEPTH * (32 + 32)) + // ReferralUpline
                           4 + (3 * (1 + 32)) + 1 + // ReferralChain
                           8 + // reserved_sol
                           8;  // reserved_tokens
}

// Error codes
#[error_code]
pub enum ErrorCode {
    #[msg("State account already initialized")]
    AlreadyInitialized,
    
    #[msg("Invalid state account (must be owned by program)")]
    InvalidStateAccount,

    #[msg("Invalid state account size")]
    InvalidStateSize,

    #[msg("Invalid vault A LP address")]
    InvalidVaultALpAddress,
    
    #[msg("Invalid vault A LP mint address")]
    InvalidVaultALpMintAddress,
    
    #[msg("Invalid token A vault address")]
    InvalidTokenAVaultAddress,

    #[msg("Referrer account is not registered")]
    ReferrerNotRegistered,

    #[msg("Invalid upline relationship")]
    InvalidUpline,

    #[msg("Invalid upline depth")]
    InvalidUplineDepth,

    #[msg("Not authorized")]
    NotAuthorized,

    #[msg("Chain is already full")]
    ChainFull,

    #[msg("Slot account not owned by program")]
    InvalidSlotOwner,

    #[msg("Slot account not registered")]
    SlotNotRegistered,

    #[msg("Invalid referrer in chain slot")]
    InvalidSlotReferrer,

    #[msg("Cannot load upline account")]
    CannotLoadUplineAccount,

    #[msg("Invalid account discriminator")]
    InvalidAccountDiscriminator,

    #[msg("Insufficient deposit amount")]
    InsufficientDeposit,

    #[msg("Failed to process deposit to pool")]
    DepositToPoolFailed,

    #[msg("Failed to process SOL reserve")]
    SolReserveFailed,

    #[msg("Failed to process referrer payment")]
    ReferrerPaymentFailed,
    
    #[msg("Failed to wrap SOL to WSOL")]
    WrapSolFailed,
    
    #[msg("Failed to unwrap WSOL to SOL")]
    UnwrapSolFailed,
    
    #[msg("Failed to mint tokens")]
    TokenMintFailed,
    
    #[msg("Failed to transfer tokens")]
    TokenTransferFailed,

    #[msg("Invalid pool address")]
    InvalidPoolAddress,
    
    #[msg("Invalid vault address")]
    InvalidVaultAddress,
    
    #[msg("Invalid token mint address")]
    InvalidTokenMintAddress,
    
    #[msg("Invalid token account")]
    InvalidTokenAccount,
    
    #[msg("Invalid wallet for ATA")]
    InvalidWalletForATA,

    #[msg("Failed to create upline entry")]
    UplineEntryCreationFailed,

    #[msg("Missing required account for upline")]
    MissingUplineAccount,
    
    #[msg("Payment wallet is not a system account")]
    PaymentWalletInvalid,
    
    #[msg("Token account is not a valid ATA")]
    TokenAccountInvalid,

    #[msg("Missing vault A accounts")]
    MissingVaultAAccounts,
    
    #[msg("Failed to read price feed")]
    PriceFeedReadFailed,
    
    #[msg("Price feed too old")]
    PriceFeedTooOld,
    
    #[msg("Invalid Chainlink program")]
    InvalidChainlinkProgram,
    
    #[msg("Invalid price feed")]
    InvalidPriceFeed,
}

// Event structure for slot filling
#[event]
pub struct SlotFilled {
    pub slot_idx: u8,     // Slot index (0, 1, 2)
    pub chain_id: u32,    // Chain ID
    pub user: Pubkey,     // User who filled the slot
    pub owner: Pubkey,    // Owner of the matrix
}

// Decimal handling for price display
#[derive(Default)]
pub struct Decimal {
    pub value: i128,
    pub decimals: u32,
}

impl Decimal {
    pub fn new(value: i128, decimals: u32) -> Self {
        Decimal { value, decimals }
    }
}

impl std::fmt::Display for Decimal {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        let mut scaled_val = self.value.to_string();
        if scaled_val.len() <= self.decimals as usize {
            scaled_val.insert_str(
                0,
                &vec!["0"; self.decimals as usize - scaled_val.len()].join(""),
            );
            scaled_val.insert_str(0, "0.");
        } else {
            scaled_val.insert(scaled_val.len() - self.decimals as usize, '.');
        }
        f.write_str(&scaled_val)
    }
}

// Helper function to force memory cleanup
fn force_memory_cleanup() {
    // Just create a vector to force a heap allocation
    let _dummy = Vec::<u8>::new();
    // The vector will be automatically freed when it goes out of scope
}

// Function to get SOL/USD price from Chainlink feed
fn get_sol_usd_price<'info>(
    chainlink_feed: &AccountInfo<'info>,
    chainlink_program: &AccountInfo<'info>,
) -> Result<(i128, u32, i64, i64)> { // Returns also the feed_timestamp
    // Get the latest round data
    let round = chainlink::latest_round_data(
        chainlink_program.clone(),
        chainlink_feed.clone(),
    ).map_err(|_| error!(ErrorCode::PriceFeedReadFailed))?;

    // Get the decimals
    let decimals = chainlink::decimals(
        chainlink_program.clone(),
        chainlink_feed.clone(),
    ).map_err(|_| error!(ErrorCode::PriceFeedReadFailed))?;

    // Get current timestamp
    let clock = Clock::get()?;
    let current_timestamp = clock.unix_timestamp;
    
    // Return price, decimals, current time, and feed timestamp
    Ok((round.answer, decimals.into(), current_timestamp, round.timestamp.into()))
}


// Function to calculate minimum SOL deposit based on USD price
fn calculate_minimum_sol_deposit<'info>(
    chainlink_feed: &AccountInfo<'info>, 
    chainlink_program: &AccountInfo<'info>
) -> Result<u64> {
    let (price, decimals, current_timestamp, feed_timestamp) = get_sol_usd_price(chainlink_feed, chainlink_program)?;
    
    // Check if price feed is too old (24 hours)
    let age = current_timestamp - feed_timestamp;
    
    let sol_price_per_unit = if age > MAX_PRICE_FEED_AGE {
        // Use default price of $100 per SOL
        DEFAULT_SOL_PRICE
    } else {
        price
    };
    
    // Convert price to SOL per unit using dynamic decimals
    let price_f64 = sol_price_per_unit as f64 / 10f64.powf(decimals as f64);
    
    // Convert MINIMUM_USD_DEPOSIT from 8 decimals to floating point
    let minimum_usd_f64 = MINIMUM_USD_DEPOSIT as f64 / 1_00000000.0; // Convert from 8 decimals
    
    // Calculate minimum SOL needed
    let minimum_sol_f64 = minimum_usd_f64 / price_f64;
    
    // Convert to lamports (9 decimals for SOL)
    let minimum_lamports = (minimum_sol_f64 * 1_000_000_000.0) as u64;
    
    Ok(minimum_lamports)
}

/// Uses Meteora pool data to derive the real-time exchange rate
/// Ensures precise calculations at any scale, from 0.000000001 to millions of tokens
/// Calculate DONUT tokens equivalent to a SOL amount using simplified calculation with high precision
fn get_donut_tokens_amount<'info>(
    a_vault_lp: &AccountInfo<'info>,
    b_vault_lp: &AccountInfo<'info>,
    a_vault_lp_mint: &AccountInfo<'info>,
    b_vault_lp_mint: &AccountInfo<'info>,
    a_token_vault: &AccountInfo<'info>,
    b_token_vault: &AccountInfo<'info>,
    sol_amount: u64,
) -> Result<u64> {
    // Constants for calculations
    const METEORA_FEE: i128 = 1800; // 3.25%
    const FEE_DENOMINATOR: i128 = 10000; // Base for percentages
    const PRECISION_FACTOR: i128 = 1_000_000_000; // For precision in divisions
    
    // Log the input parameter
    msg!("get_donut_tokens_amount called with sol_amount: {}", sol_amount);
    
    // 1. Read LP token values using deserialization
    let a_vault_lp_amount: u64;
    let b_vault_lp_amount: u64;
    
    {
        // Deserialize the LP token accounts
        let a_vault_lp_data = match spl_token::state::Account::unpack(&a_vault_lp.try_borrow_data()?) {
            Ok(data) => data,
            Err(_) => {
                msg!("Error reading LP data");
                return Ok(100 * 1_000_000_000);
            }
        };
            
        let b_vault_lp_data = match spl_token::state::Account::unpack(&b_vault_lp.try_borrow_data()?) {
            Ok(data) => data,
            Err(_) => {
                msg!("Error reading LP data");
                return Ok(100 * 1_000_000_000);
            }
        };
        
        a_vault_lp_amount = a_vault_lp_data.amount;
        b_vault_lp_amount = b_vault_lp_data.amount;
        msg!("LP amounts - A: {}, B: {}", a_vault_lp_amount, b_vault_lp_amount);
    }
    
    force_memory_cleanup();
    
    // 2. Read total LP token supplies
    let a_vault_lp_supply: u64;
    let b_vault_lp_supply: u64;
    
    {
        let a_vault_lp_mint_data = match spl_token::state::Mint::unpack(&a_vault_lp_mint.try_borrow_data()?) {
            Ok(data) => data,
            Err(_) => {
                msg!("Error reading LP mint data");
                return Ok(100 * 1_000_000_000);
            }
        };
            
        let b_vault_lp_mint_data = match spl_token::state::Mint::unpack(&b_vault_lp_mint.try_borrow_data()?) {
            Ok(data) => data,
            Err(_) => {
                msg!("Error reading LP mint data");
                return Ok(100 * 1_000_000_000);
            }
        };
        
        a_vault_lp_supply = a_vault_lp_mint_data.supply;
        b_vault_lp_supply = b_vault_lp_mint_data.supply;
        msg!("LP supplies - A: {}, B: {}", a_vault_lp_supply, b_vault_lp_supply);
    }
    
    force_memory_cleanup();
    
    // 3. Read total token values in the vaults
    let total_token_a_amount: u64;
    let total_token_b_amount: u64;
    
    {
        let a_token_vault_data = match spl_token::state::Account::unpack(&a_token_vault.try_borrow_data()?) {
            Ok(data) => data,
            Err(_) => {
                msg!("Error reading token vault data");
                return Ok(100 * 1_000_000_000);
            }
        };
            
        let b_token_vault_data = match spl_token::state::Account::unpack(&b_token_vault.try_borrow_data()?) {
            Ok(data) => data,
            Err(_) => {
                msg!("Error reading token vault data");
                return Ok(100 * 1_000_000_000);
            }
        };
        
        total_token_a_amount = a_token_vault_data.amount;
        total_token_b_amount = b_token_vault_data.amount;
        msg!("Total token amounts - A: {}, B: {}", total_token_a_amount, total_token_b_amount);
    }
    
    force_memory_cleanup();
    
    // 4. Check for zero values to avoid division by zero
    if a_vault_lp_supply == 0 || b_vault_lp_supply == 0 || total_token_a_amount == 0 || total_token_b_amount == 0 {
        msg!("Zero values detected, using fallback");
        return Ok(100 * 1_000_000_000);
    }
    
    // 5. Convert to i128 for safe calculations
    let a_lp_amount_big = a_vault_lp_amount as i128;
    let a_lp_supply_big = a_vault_lp_supply as i128;
    let b_lp_amount_big = b_vault_lp_amount as i128;
    let b_lp_supply_big = b_vault_lp_supply as i128;
    let token_a_big = total_token_a_amount as i128;
    let token_b_big = total_token_b_amount as i128;
    let sol_amount_big = sol_amount as i128;
    
    // 6. Calculate token quantities in the pool with safe operations
    let pool_token_a = match token_a_big.checked_mul(a_lp_amount_big) {
        Some(num) => match num.checked_div(a_lp_supply_big) {
            Some(result) => result,
            None => {
                msg!("Division by zero in pool_token_a calculation");
                return Ok(100 * 1_000_000_000);
            }
        },
        None => {
            msg!("Overflow in pool_token_a calculation");
            return Ok(100 * 1_000_000_000);
        }
    };
    
    let pool_token_b = match token_b_big.checked_mul(b_lp_amount_big) {
        Some(num) => match num.checked_div(b_lp_supply_big) {
            Some(result) => result,
            None => {
                msg!("Division by zero in pool_token_b calculation");
                return Ok(100 * 1_000_000_000);
            }
        },
        None => {
            msg!("Overflow in pool_token_b calculation");
            return Ok(100 * 1_000_000_000);
        }
    };
    
    msg!("Pool tokens - A: {}, B: {}", pool_token_a, pool_token_b);
    
    // 7. Check for zero values
    if pool_token_a == 0 || pool_token_b == 0 {
        msg!("Zero pool tokens, using fallback");
        return Ok(100 * 1_000_000_000);
    }
    
    // 8. Calculate the basic ratio with overflow checks
    let basic_ratio = match pool_token_a.checked_mul(PRECISION_FACTOR) {
        Some(num) => match num.checked_div(pool_token_b) {
            Some(result) => result,
            None => {
                msg!("Division by zero in basic_ratio calculation");
                return Ok(100 * 1_000_000_000);
            }
        },
        None => {
            msg!("Overflow in basic_ratio calculation");
            return Ok(100 * 1_000_000_000);
        }
    };
    
    msg!("Basic ratio without fees (scaled): {}", basic_ratio);
    
    // 9. Calculate the fee multiplier with overflow checks
    let fee_multiplier = match FEE_DENOMINATOR.checked_mul(PRECISION_FACTOR) {
        Some(num) => {
            let denominator = match FEE_DENOMINATOR.checked_sub(METEORA_FEE) {
                Some(val) => val,
                None => {
                    msg!("Underflow in fee denominator calculation");
                    return Ok(100 * 1_000_000_000);
                }
            };
            
            match num.checked_div(denominator) {
                Some(result) => result,
                None => {
                    msg!("Division by zero in fee_multiplier calculation");
                    return Ok(100 * 1_000_000_000);
                }
            }
        },
        None => {
            msg!("Overflow in fee_multiplier calculation");
            return Ok(100 * 1_000_000_000);
        }
    };
    
    msg!("Fee multiplier (scaled): {}", fee_multiplier);
    
    // 10. Apply the fee multiplier with overflow checks
    let fee_adjusted_ratio = match basic_ratio.checked_mul(fee_multiplier) {
        Some(num) => match num.checked_div(PRECISION_FACTOR) {
            Some(result) => result,
            None => {
                msg!("Division by zero in fee_adjusted_ratio calculation");
                return Ok(100 * 1_000_000_000);
            }
        },
        None => {
            msg!("Overflow in fee_adjusted_ratio calculation");
            return Ok(100 * 1_000_000_000);
        }
    };
    
    msg!("Fee adjusted ratio (scaled): {}", fee_adjusted_ratio);
    
    // 11. Calculate tokens with overflow checks
    let donut_tokens_scaled = match sol_amount_big.checked_mul(fee_adjusted_ratio) {
        Some(result) => result,
        None => {
            msg!("Overflow in donut_tokens_scaled calculation");
            return Ok(100 * 1_000_000_000);
        }
    };
    
    msg!("Donut tokens scaled: {}", donut_tokens_scaled);
    
    //12. Remove precision factor with overflow checks
    let donut_tokens_big = match donut_tokens_scaled.checked_div(PRECISION_FACTOR) {
        Some(result) => result,
        None => {
            msg!("Division by zero in donut_tokens_big calculation");
            return Ok(100 * 1_000_000_000);
        }
    };

    msg!("donut_tokens_big (i128): {}", donut_tokens_big);
    
    //13. Check for overflow to u64
    if donut_tokens_big > i128::from(u64::MAX) {
        msg!("donut_tokens_big exceeds u64::MAX");
        return Ok(100 * 1_000_000_000);
    }

    //14. Convert to u64
    let donut_tokens = donut_tokens_big as u64;

    msg!("Final donut_tokens (u64): {}", donut_tokens);
    
    // 15. Validate that we have a non-zero value
    if donut_tokens == 0 {
        // If the original calculation was positive but truncated to zero
        if donut_tokens_big > 0 {
            msg!("Small positive value truncated to zero, returning minimum value");
            return Ok(1); // 0.000000001 DONUT (smallest possible value)
        }
        
        msg!("donut_tokens is zero, using fallback");
        return Ok(100 * 1_000_000_000);
    }
    
    Ok(donut_tokens)
}

// Function to strictly verify an address
fn verify_address_strict(provided: &Pubkey, expected: &Pubkey, error_code: ErrorCode) -> Result<()> {
    if provided != expected {
        return Err(error!(error_code));
    }
    Ok(())
}

// Verify vault A addresses
fn verify_vault_a_addresses<'info>(
    a_vault_lp: &Pubkey,
    a_vault_lp_mint: &Pubkey,
    a_token_vault: &Pubkey
) -> Result<()> {
    verify_address_strict(a_vault_lp, &verified_addresses::A_VAULT_LP, ErrorCode::InvalidVaultALpAddress)?;
    verify_address_strict(a_vault_lp_mint, &verified_addresses::A_VAULT_LP_MINT, ErrorCode::InvalidVaultALpMintAddress)?;
    verify_address_strict(a_token_vault, &verified_addresses::A_TOKEN_VAULT, ErrorCode::InvalidTokenAVaultAddress)?;
    
    Ok(())
}

// Function to strictly verify an ATA account
fn verify_ata_strict<'info>(
    token_account: &AccountInfo<'info>,
    owner: &Pubkey,
    expected_mint: &Pubkey
) -> Result<()> {
    if token_account.owner != &spl_token::id() {
        return Err(error!(ErrorCode::InvalidTokenAccount));
    }
    
    match TokenAccount::try_deserialize(&mut &token_account.data.borrow()[..]) {
        Ok(token_data) => {
            if token_data.owner != *owner {
                return Err(error!(ErrorCode::InvalidWalletForATA));
            }
            
            if token_data.mint != *expected_mint {
                return Err(error!(ErrorCode::InvalidTokenMintAddress));
            }
        },
        Err(_) => {
            return Err(error!(ErrorCode::InvalidTokenAccount));
        }
    }
    
    Ok(())
}

// Function to verify all fixed addresses at once
fn verify_all_fixed_addresses<'info>(
    pool: &Pubkey,
    b_vault_lp: &Pubkey,
    token_mint: &Pubkey,
    wsol_mint: &Pubkey,
) -> Result<()> {
    // Pool and vaults verifications
    verify_address_strict(pool, &verified_addresses::POOL_ADDRESS, ErrorCode::InvalidPoolAddress)?;
    verify_address_strict(b_vault_lp, &verified_addresses::B_VAULT_LP, ErrorCode::InvalidVaultAddress)?;
    
    // Token and oracle verifications
    verify_address_strict(token_mint, &verified_addresses::TOKEN_MINT, ErrorCode::InvalidTokenMintAddress)?;
    verify_address_strict(wsol_mint, &verified_addresses::WSOL_MINT, ErrorCode::InvalidTokenMintAddress)?;
    
    Ok(())
}

// Function to verify Chainlink addresses
fn verify_chainlink_addresses<'info>(
    chainlink_program: &Pubkey,
    chainlink_feed: &Pubkey,
) -> Result<()> {
    verify_address_strict(chainlink_program, &verified_addresses::CHAINLINK_PROGRAM, ErrorCode::InvalidChainlinkProgram)?;
    verify_address_strict(chainlink_feed, &verified_addresses::SOL_USD_FEED, ErrorCode::InvalidPriceFeed)?;
    
    Ok(())
}

// Verify if an account is a valid wallet (system account)
fn verify_wallet_is_system_account<'info>(wallet: &AccountInfo<'info>) -> Result<()> {
    if wallet.owner != &solana_program::system_program::ID {
        return Err(error!(ErrorCode::PaymentWalletInvalid));
    }
    
    Ok(())
}

// Verify if an account is a valid ATA
fn verify_token_account<'info>(
    token_account: &AccountInfo<'info>,
    wallet: &Pubkey,
    token_mint: &Pubkey
) -> Result<()> {
    if token_account.owner != &spl_token::id() {
        return Err(error!(ErrorCode::TokenAccountInvalid));
    }
    
    let token_data = match TokenAccount::try_deserialize(&mut &token_account.data.borrow()[..]) {
        Ok(data) => data,
        Err(_) => {
            return Err(error!(ErrorCode::TokenAccountInvalid));
        }
    };
    
    if token_data.owner != *wallet {
        return Err(error!(ErrorCode::TokenAccountInvalid));
    }
    
    if token_data.mint != *token_mint {
        return Err(error!(ErrorCode::TokenAccountInvalid));
    }
    
    Ok(())
}

// Function to process deposit to the liquidity pool
fn process_deposit_to_pool<'info>(
    user: &AccountInfo<'info>,
    user_source_token: &AccountInfo<'info>,
    b_vault_lp: &AccountInfo<'info>,
    b_vault: &UncheckedAccount<'info>,
    b_token_vault: &AccountInfo<'info>,
    b_vault_lp_mint: &AccountInfo<'info>,
    vault_program: &UncheckedAccount<'info>,
    token_program: &Program<'info, Token>,
    amount: u64,
) -> Result<()> {
    let deposit_accounts = [
        b_vault.to_account_info(),
        b_token_vault.clone(),
        b_vault_lp_mint.clone(),
        user_source_token.clone(),
        b_vault_lp.clone(),
        user.clone(),
        token_program.to_account_info(),
    ];

    let mut deposit_data = Vec::with_capacity(24);
    deposit_data.extend_from_slice(&[242, 35, 198, 137, 82, 225, 242, 182]); // Deposit sighash
    deposit_data.extend_from_slice(&amount.to_le_bytes());
    deposit_data.extend_from_slice(&0u64.to_le_bytes()); // minimum_lp_token_amount = 0

    solana_program::program::invoke(
        &solana_program::instruction::Instruction {
            program_id: vault_program.key(),
            accounts: deposit_accounts.iter().enumerate().map(|(i, a)| {
                if i == 5 {
                    solana_program::instruction::AccountMeta::new_readonly(a.key(), true)
                } else if i < 5 {
                    solana_program::instruction::AccountMeta::new(a.key(), false)
                } else {
                    solana_program::instruction::AccountMeta::new_readonly(a.key(), false)
                }
            }).collect::<Vec<solana_program::instruction::AccountMeta>>(),
            data: deposit_data,
        },
        &deposit_accounts,
    ).map_err(|_| error!(ErrorCode::DepositToPoolFailed))?;
    
    Ok(())
}

// Function to reserve SOL for the referrer
fn process_reserve_sol<'info>(
    from: &AccountInfo<'info>,
    to: &AccountInfo<'info>,
    amount: u64,
) -> Result<()> {
    let ix = solana_program::system_instruction::transfer(
        &from.key(),
        &to.key(),
        amount
    );
    
    solana_program::program::invoke(
        &ix,
        &[from.clone(), to.clone()],
    ).map_err(|_| error!(ErrorCode::SolReserveFailed))?;
    
    Ok(())
}

// Function process_pay_referrer with explicit lifetimes
fn process_pay_referrer<'info>(
    from: &AccountInfo<'info>,
    to: &AccountInfo<'info>,
    amount: u64,
    signer_seeds: &[&[&[u8]]],
) -> Result<()> {
    verify_wallet_is_system_account(to)?;
    
    let ix = solana_program::system_instruction::transfer(
        &from.key(),
        &to.key(),
        amount
    );
    
    // Create a vector of AccountInfo to avoid lifetime problems
    let mut accounts = Vec::with_capacity(2);
    accounts.push(from.clone());
    accounts.push(to.clone());
    
    solana_program::program::invoke_signed(
        &ix,
        &accounts,
        signer_seeds,
    ).map_err(|_| error!(ErrorCode::ReferrerPaymentFailed))?;
    
    Ok(())
}

// Function to mint tokens for the program vault
pub fn process_mint_tokens<'info>(
    token_mint: &AccountInfo<'info>,
    program_token_vault: &AccountInfo<'info>,
    token_mint_authority: &AccountInfo<'info>,
    token_program: &Program<'info, Token>,
    amount: u64,
    mint_authority_seeds: &[&[&[u8]]],
) -> Result<()> {
    let mint_instruction = spl_token::instruction::mint_to(
        &token_program.key(),
        &token_mint.key(),
        &program_token_vault.key(),
        &token_mint_authority.key(),
        &[],
        amount
    ).map_err(|_| error!(ErrorCode::TokenMintFailed))?;
    
    // Use Vec instead of fixed array to avoid lifetime problems
    let mut mint_accounts = Vec::with_capacity(4);
    mint_accounts.push(token_mint.clone());
    mint_accounts.push(program_token_vault.clone());
    mint_accounts.push(token_mint_authority.clone());
    mint_accounts.push(token_program.to_account_info());
    
    solana_program::program::invoke_signed(
        &mint_instruction,
        &mint_accounts,
        mint_authority_seeds,
    ).map_err(|_| error!(ErrorCode::TokenMintFailed))?;
    
    Ok(())
}

// Function to transfer tokens from vault to user
pub fn process_transfer_tokens<'info>(
    program_token_vault: &AccountInfo<'info>,
    user_token_account: &AccountInfo<'info>,
    vault_authority: &AccountInfo<'info>,
    token_program: &Program<'info, Token>,
    amount: u64,
    authority_seeds: &[&[&[u8]]],
) -> Result<()> {
    if user_token_account.owner != &spl_token::id() {
        return Err(error!(ErrorCode::TokenAccountInvalid));
    }
    
    let transfer_instruction = spl_token::instruction::transfer(
        &token_program.key(),
        &program_token_vault.key(),
        &user_token_account.key(),
        &vault_authority.key(),
        &[],
        amount
    ).map_err(|_| error!(ErrorCode::TokenTransferFailed))?;
    
    // Use Vec instead of fixed array to avoid lifetime problems
    let mut transfer_accounts = Vec::with_capacity(4);
    transfer_accounts.push(program_token_vault.clone());
    transfer_accounts.push(user_token_account.clone());
    transfer_accounts.push(vault_authority.clone());
    transfer_accounts.push(token_program.to_account_info());
    
    solana_program::program::invoke_signed(
        &transfer_instruction,
        &transfer_accounts,
        authority_seeds,
    ).map_err(|_| error!(ErrorCode::TokenTransferFailed))?;
    
    Ok(())
}

/// Process the direct referrer's matrix when a new user registers
/// Returns (bool, Pubkey) where:
/// - bool: indicates if the matrix was completed
/// - Pubkey: referrer key for use in recursion
fn process_referrer_chain<'info>(
   user_key: &Pubkey,
   referrer: &mut Account<'_, UserAccount>,
   next_chain_id: u32,
) -> Result<(bool, Pubkey)> {
   let slot_idx = referrer.chain.filled_slots as usize;
   if slot_idx >= 3 {
       return Ok((false, referrer.key())); 
   }

   referrer.chain.slots[slot_idx] = Some(*user_key);

   // Emit slot filled event
   emit!(SlotFilled {
       slot_idx: slot_idx as u8,
       chain_id: referrer.chain.id,
       user: *user_key,
       owner: referrer.key(),
   });

   referrer.chain.filled_slots += 1;

   if referrer.chain.filled_slots == 3 {
       referrer.chain.id = next_chain_id;
       referrer.chain.slots = [None, None, None];
       referrer.chain.filled_slots = 0;

       return Ok((true, referrer.key()));
   }

   Ok((false, referrer.key()))
}

// Accounts for initialize instruction
#[derive(Accounts)]
pub struct Initialize<'info> {
    #[account(
        mut,
        constraint = state.owner == crate::ID @ ErrorCode::InvalidStateAccount,
        constraint = state.to_account_info().data_len() == 8 + ProgramState::SIZE @ ErrorCode::InvalidStateSize
    )]
    pub state: Account<'info, ProgramState>,

    #[account(mut)]
    pub owner: Signer<'info>,

    pub system_program: Program<'info, System>,
}

// Accounts for registration without referrer with deposit
// Accounts for registration without referrer with deposit
#[derive(Accounts)]
#[instruction(deposit_amount: u64)]
pub struct RegisterWithoutReferrerDeposit<'info> {
    #[account(mut)]
    pub state: Account<'info, ProgramState>,

    #[account(mut)]
    pub owner: Signer<'info>,
    
    #[account(mut)]
    pub user_wallet: Signer<'info>,
    
    #[account(
        init,
        payer = user_wallet,
        space = 8 + UserAccount::SIZE,
        seeds = [b"user_account", user_wallet.key().as_ref()],
        bump
    )]
    pub user: Account<'info, UserAccount>,

    // WSOL ATA account
    #[account(
        init,
        payer = user_wallet,
        associated_token::mint = wsol_mint,
        associated_token::authority = user_wallet
    )]
    pub user_wsol_account: Account<'info, TokenAccount>,
    
    // WSOL mint
    /// CHECK: This is the fixed WSOL mint address
    pub wsol_mint: AccountInfo<'info>,

    // Deposit Accounts (same logic as Slot 1)
    /// CHECK: Pool account (PDA)
    #[account(mut)]
    pub pool: UncheckedAccount<'info>,

    // Existing accounts for vault B (SOL)
    /// CHECK: Vault account for token B (SOL)
    #[account(mut)]
    pub b_vault: UncheckedAccount<'info>,

    /// CHECK: Token vault account for token B (SOL)
    #[account(mut)]
    pub b_token_vault: UncheckedAccount<'info>,

    /// CHECK: LP token mint for vault B
    #[account(mut)]
    pub b_vault_lp_mint: UncheckedAccount<'info>,

    /// CHECK: LP token account for vault B
    #[account(mut)]
    pub b_vault_lp: UncheckedAccount<'info>,

    /// CHECK: Vault program
    pub vault_program: UncheckedAccount<'info>,

    // TOKEN MINT - Added for base user
    /// CHECK: Token mint to create the UplineEntry structure
    pub token_mint: UncheckedAccount<'info>,

    // Required programs
    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub rent: Sysvar<'info, Rent>,
}

// Structure for registration with SOL in a single transaction
// Now includes Chainlink accounts and remaining_accounts
#[derive(Accounts)]
#[instruction(deposit_amount: u64)]
pub struct RegisterWithSolDeposit<'info> {
    #[account(mut)]
    pub state: Account<'info, ProgramState>,

    #[account(mut)]
    pub user_wallet: Signer<'info>,

    // Reference accounts
    #[account(mut)]
    pub referrer: Account<'info, UserAccount>,
    
    #[account(mut)]
    pub referrer_wallet: SystemAccount<'info>,

    // User account
    #[account(
        init,
        payer = user_wallet,
        space = 8 + UserAccount::SIZE,
        seeds = [b"user_account", user_wallet.key().as_ref()],
        bump
    )]
    pub user: Account<'info, UserAccount>,

    // New WSOL ATA account
    #[account(
        init,
        payer = user_wallet,
        associated_token::mint = wsol_mint,
        associated_token::authority = user_wallet
    )]
    pub user_wsol_account: Account<'info, TokenAccount>,
    
    // WSOL mint
    /// CHECK: This is the fixed WSOL mint address
    pub wsol_mint: AccountInfo<'info>,

    // Deposit Accounts (Slot 1 and 3)
    /// CHECK: Pool account (PDA)
    #[account(mut)]
    pub pool: UncheckedAccount<'info>,

    // Existing accounts for vault B (SOL)
    /// CHECK: Vault account for token B (SOL)
    #[account(mut)]
    pub b_vault: UncheckedAccount<'info>,

    /// CHECK: Token vault account for token B (SOL)
    #[account(mut)]
    pub b_token_vault: UncheckedAccount<'info>,

    /// CHECK: LP token mint for vault B
    #[account(mut)]
    pub b_vault_lp_mint: UncheckedAccount<'info>,

    /// CHECK: LP token account for vault B
    #[account(mut)]
    pub b_vault_lp: UncheckedAccount<'info>,

    /// CHECK: Vault program
    pub vault_program: UncheckedAccount<'info>,

    // Accounts for SOL reserve (Slot 2)
    #[account(
        mut,
        seeds = [b"program_sol_vault"],
        bump
    )]
    pub program_sol_vault: SystemAccount<'info>,
    
    // ACCOUNTS FOR TOKENS (Slot 2 and 3)
    /// CHECK: Token mint for minting new tokens
    #[account(mut)]
    pub token_mint: UncheckedAccount<'info>,
    
    /// CHECK: Program token vault to store reserved tokens
    #[account(mut)]
    pub program_token_vault: UncheckedAccount<'info>,
    
    /// CHECK: Referrer's ATA to receive tokens
    #[account(mut)]
    pub referrer_token_account: UncheckedAccount<'info>,
    
    // Authority to mint tokens (program PDA)
    /// CHECK: Mint authority PDA
    #[account(
        seeds = [b"token_mint_authority"],
        bump
    )]
    pub token_mint_authority: UncheckedAccount<'info>,
    
    // Vault authority for token transfers
    /// CHECK: Token vault authority
    #[account(
        seeds = [b"token_vault_authority"],
        bump
    )]
    pub vault_authority: UncheckedAccount<'info>,

    // Required programs
    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub rent: Sysvar<'info, Rent>,
}

#[program]
pub mod referral_system {
    use super::*;

    // Initialize program state
    pub fn initialize(ctx: Context<Initialize>) -> Result<()> {
        if ctx.accounts.state.owner != Pubkey::default() {
            return Err(error!(ErrorCode::AlreadyInitialized));
        }
        
        let state = &mut ctx.accounts.state;
        state.owner = ctx.accounts.owner.key();
        state.multisig_treasury = admin_addresses::MULTISIG_TREASURY;
        state.next_upline_id = 1;
        state.next_chain_id = 1;
        
        Ok(())
    }
    
    // Register without a referrer (owner only)
    pub fn register_without_referrer(ctx: Context<RegisterWithoutReferrerDeposit>, deposit_amount: u64) -> Result<()> {
        // Verify if the caller is the program owner
        if ctx.accounts.owner.key() != admin_addresses::MULTISIG_TREASURY {
            return Err(error!(ErrorCode::NotAuthorized));
        }
       
        // STRICT VERIFICATION OF ALL ADDRESSES
        verify_all_fixed_addresses(
            &ctx.accounts.pool.key(),
            &ctx.accounts.b_vault_lp.key(),
            &ctx.accounts.token_mint.key(),
            &ctx.accounts.wsol_mint.key(),
        )?;

        // Use global upline ID
        let state = &mut ctx.accounts.state;
        let upline_id = state.next_upline_id;
        let chain_id = state.next_chain_id;

        state.next_upline_id += 1;
        state.next_chain_id += 1;

        // Create new user data
        let user = &mut ctx.accounts.user;

        // Initialize user data with an empty upline structure
        user.is_registered = true;
        user.referrer = None;
        user.owner_wallet = ctx.accounts.user_wallet.key();
        user.upline = ReferralUpline {
            id: upline_id,
            depth: 1,
            upline: vec![],
        };
        user.chain = ReferralChain {
            id: chain_id,
            slots: [None, None, None],
            filled_slots: 0,
        };
        
        // Initialize financial data
        user.reserved_sol = 0;
        user.reserved_tokens = 0;
        
        // 1. Transfer SOL to WSOL (wrap)
        let transfer_ix = solana_program::system_instruction::transfer(
            &ctx.accounts.user_wallet.key(),
            &ctx.accounts.user_wsol_account.key(),
            deposit_amount
        );
        
        let wrap_accounts = [
            ctx.accounts.user_wallet.to_account_info(),
            ctx.accounts.user_wsol_account.to_account_info(),
        ];
        
        solana_program::program::invoke(
            &transfer_ix,
            &wrap_accounts,
        ).map_err(|_| error!(ErrorCode::WrapSolFailed))?;
        
        // 2. Sync the WSOL account
        let sync_native_ix = spl_token::instruction::sync_native(
            &token::ID,
            &ctx.accounts.user_wsol_account.key(),
        )?;
        
        let sync_accounts = [ctx.accounts.user_wsol_account.to_account_info()];
        
        solana_program::program::invoke(
            &sync_native_ix,
            &sync_accounts,
        ).map_err(|_| error!(ErrorCode::WrapSolFailed))?;
        
        // Deposit to liquidity pool using the WSOL account
        process_deposit_to_pool(
            &ctx.accounts.user_wallet.to_account_info(),
            &ctx.accounts.user_wsol_account.to_account_info(),
            &ctx.accounts.b_vault_lp.to_account_info(),
            &ctx.accounts.b_vault,
            &ctx.accounts.b_token_vault.to_account_info(),
            &ctx.accounts.b_vault_lp_mint.to_account_info(),
            &ctx.accounts.vault_program,
            &ctx.accounts.token_program,
            deposit_amount
        )?;

        // Emit event for the deposit (slot 0 for user without referrer)
        emit!(SlotFilled {
            slot_idx: 0,
            chain_id: chain_id,
            user: ctx.accounts.user_wallet.key(),
            owner: ctx.accounts.user.key(),
        });

        Ok(())
    }

    // Register user with SOL in a single transaction - Modified to use remaining_accounts
    pub fn register_with_sol_deposit<'a, 'b, 'c, 'info>(ctx: Context<'a, 'b, 'c, 'info, RegisterWithSolDeposit<'info>>, deposit_amount: u64) -> Result<()> {
        // Check if referrer is registered
        if !ctx.accounts.referrer.is_registered {
            return Err(error!(ErrorCode::ReferrerNotRegistered));
        }

        // Check if we have vault A accounts in remaining_accounts
        if ctx.remaining_accounts.len() < VAULT_A_ACCOUNTS_COUNT + 2 { // +2 for Chainlink accounts
            return Err(error!(ErrorCode::MissingVaultAAccounts));
        }

        // Extract vault A accounts from the beginning of remaining_accounts
        let a_vault_lp = &ctx.remaining_accounts[0];
        let a_vault_lp_mint = &ctx.remaining_accounts[1];
        let a_token_vault = &ctx.remaining_accounts[2];

        // Verify Vault A addresses
        verify_vault_a_addresses(
            &a_vault_lp.key(),
            &a_vault_lp_mint.key(),
            &a_token_vault.key()
        )?;

        // Extract Chainlink accounts from remaining_accounts
        let chainlink_feed = &ctx.remaining_accounts[3];
        let chainlink_program = &ctx.remaining_accounts[4];

        // STRICT VERIFICATION OF ALL ADDRESSES
        verify_all_fixed_addresses(
            &ctx.accounts.pool.key(),
            &ctx.accounts.b_vault_lp.key(),
            &ctx.accounts.token_mint.key(),
            &ctx.accounts.wsol_mint.key(),
        )?;

        // Verify Chainlink addresses
        verify_chainlink_addresses(
            &chainlink_program.key(),
            &chainlink_feed.key(),
        )?;

        // Get minimum deposit amount from Chainlink feed
        let minimum_deposit = calculate_minimum_sol_deposit(
            chainlink_feed,
            chainlink_program,
        )?;

        // Verify deposit amount meets the minimum requirement
        if deposit_amount < minimum_deposit {
            msg!("Deposit amount: {}, minimum required: {}", deposit_amount, minimum_deposit);
            return Err(error!(ErrorCode::InsufficientDeposit));
        }

        // Verify referrer's ATA account
        verify_ata_strict(
            &ctx.accounts.referrer_token_account.to_account_info(),
            &ctx.accounts.referrer_wallet.key(),
            &ctx.accounts.token_mint.key()
        )?;
        
        // 1. Transfer SOL to WSOL (wrap)
        let transfer_ix = solana_program::system_instruction::transfer(
            &ctx.accounts.user_wallet.key(),
            &ctx.accounts.user_wsol_account.key(),
            deposit_amount
        );
        
        let wrap_accounts = [
            ctx.accounts.user_wallet.to_account_info(),
            ctx.accounts.user_wsol_account.to_account_info(),
        ];
        
        solana_program::program::invoke(
            &transfer_ix,
            &wrap_accounts,
        ).map_err(|_| error!(ErrorCode::WrapSolFailed))?;
        
        // 2. Sync the WSOL account
        let sync_native_ix = spl_token::instruction::sync_native(
            &token::ID,
            &ctx.accounts.user_wsol_account.key(),
        )?;
        
        let sync_accounts = [ctx.accounts.user_wsol_account.to_account_info()];
        
        solana_program::program::invoke(
            &sync_native_ix,
            &sync_accounts,
        ).map_err(|_| error!(ErrorCode::WrapSolFailed))?;
        
        // 3. Create the new UplineEntry structure for the referrer
        let referrer_entry = UplineEntry {
            pda: ctx.accounts.referrer.key(),
            wallet: ctx.accounts.referrer_wallet.key(),
        };
        
        // 4. Create the user's upline by copying the referrer's upline and adding the referrer
        let mut new_upline = Vec::new();
        
        // OPTIMIZATION - Try to reserve exact capacity to avoid reallocations
        if ctx.accounts.referrer.upline.upline.len() >= MAX_UPLINE_DEPTH {
            // If already at depth limit, reserve space for MAX_UPLINE_DEPTH entries only
            new_upline.try_reserve(MAX_UPLINE_DEPTH).ok();
            
            // Copy only the most recent entries
            let start_idx = ctx.accounts.referrer.upline.upline.len() - (MAX_UPLINE_DEPTH - 1);
            new_upline.extend_from_slice(&ctx.accounts.referrer.upline.upline[start_idx..]);
        } else {
            // If space is available, reserve space for all existing entries plus the new one
            new_upline.try_reserve(ctx.accounts.referrer.upline.upline.len() + 1).ok();
            
            // Copy all existing entries
            new_upline.extend_from_slice(&ctx.accounts.referrer.upline.upline);
        }
        
        // Add the current referrer
        new_upline.push(referrer_entry);
        
        // OPTIMIZATION - Reduce capacity to current size
        new_upline.shrink_to_fit();

        // 5. Get upline ID from global counter
        let state = &mut ctx.accounts.state;
        let upline_id = state.next_upline_id;
        let chain_id = state.next_chain_id;

        state.next_upline_id += 1; // Increment for next user
        state.next_chain_id += 1;

        // 6. Create new user data
        let user = &mut ctx.accounts.user;

        user.is_registered = true;
        user.referrer = Some(ctx.accounts.referrer.key());
        user.owner_wallet = ctx.accounts.user_wallet.key();
        user.upline = ReferralUpline {
            id: upline_id,
            depth: ctx.accounts.referrer.upline.depth + 1,
            upline: new_upline,
        };
        user.chain = ReferralChain {
            id: chain_id,
            slots: [None, None, None],
            filled_slots: 0,
        };
        
        // Initialize user financial data
        user.reserved_sol = 0;
        user.reserved_tokens = 0;

        // ===== FINANCIAL LOGIC =====
        // Determine which slot we're filling in the referrer's matrix
        let slot_idx = ctx.accounts.referrer.chain.filled_slots as usize;

        // LOGIC FOR SLOT 1: Deposit to liquidity pool
        if slot_idx == 0 {
            // Transfer SOL to the liquidity pool using the created WSOL account
            process_deposit_to_pool(
                &ctx.accounts.user_wallet.to_account_info(),
                &ctx.accounts.user_wsol_account.to_account_info(),
                &ctx.accounts.b_vault_lp.to_account_info(),
                &ctx.accounts.b_vault,
                &ctx.accounts.b_token_vault.to_account_info(),
                &ctx.accounts.b_vault_lp_mint.to_account_info(),
                &ctx.accounts.vault_program,
                &ctx.accounts.token_program,
                deposit_amount
            )?;
            
            // Emit slot filled event with deposit
            emit!(SlotFilled {
                slot_idx: 0,
                chain_id: ctx.accounts.referrer.chain.id,
                user: ctx.accounts.user_wallet.key(),
                owner: ctx.accounts.referrer.key(),
            });
        } 
        // LOGIC FOR SLOT 2: Reserve SOL value and mint tokens
        else if slot_idx == 1 {
            // Closing the WSOL account transfers the lamports back to the owner
            let close_ix = spl_token::instruction::close_account(
                &token::ID,
                &ctx.accounts.user_wsol_account.key(),
                &ctx.accounts.user_wallet.key(),
                &ctx.accounts.user_wallet.key(),
                &[]
            )?;
            
            let close_accounts = [
                ctx.accounts.user_wsol_account.to_account_info(),
                ctx.accounts.user_wallet.to_account_info(),
                ctx.accounts.user_wallet.to_account_info(),
            ];
            
            solana_program::program::invoke(
                &close_ix,
                &close_accounts,
            ).map_err(|_| error!(ErrorCode::UnwrapSolFailed))?;
            
            // Now transfer SOL to reserve
            process_reserve_sol(
                &ctx.accounts.user_wallet.to_account_info(),
                &ctx.accounts.program_sol_vault.to_account_info(),
                deposit_amount
            )?;
            
            // Update reserved value for the referrer
            ctx.accounts.referrer.reserved_sol = deposit_amount;
            
            // Emit slot filled event with reserve
            emit!(SlotFilled {
                slot_idx: 1,
                chain_id: ctx.accounts.referrer.chain.id,
                user: ctx.accounts.user_wallet.key(),
                owner: ctx.accounts.referrer.key(),
            });
            
            // Calculate tokens based on pool value
            let token_amount = get_donut_tokens_amount(
                a_vault_lp,
                &ctx.accounts.b_vault_lp.to_account_info(),
                a_vault_lp_mint,
                &ctx.accounts.b_vault_lp_mint.to_account_info(),
                a_token_vault,
                &ctx.accounts.b_token_vault.to_account_info(),
                deposit_amount
            )?;
            
            // Force cleanup after calculation
            force_memory_cleanup();
            
            // Mint tokens for the program vault
            process_mint_tokens(
                &ctx.accounts.token_mint.to_account_info(),
                &ctx.accounts.program_token_vault.to_account_info(),
                &ctx.accounts.token_mint_authority.to_account_info(),
                &ctx.accounts.token_program,
                token_amount,
                &[&[
                    b"token_mint_authority".as_ref(),
                    &[ctx.bumps.token_mint_authority]
                ]],
            )?;

            // Add cleanup:
            force_memory_cleanup();
            
            // Update reserved tokens value for the referrer
            ctx.accounts.referrer.reserved_tokens = token_amount;
        }
        // LOGIC FOR SLOT 3: Pay referrer (SOL and tokens) and start recursion
        else if slot_idx == 2 {
            // 1. Transfer the reserved SOL value to the referrer
            if ctx.accounts.referrer.reserved_sol > 0 {
                // Verify that referrer_wallet is a system account
                verify_wallet_is_system_account(&ctx.accounts.referrer_wallet.to_account_info())?;
                
                process_pay_referrer(
                    &ctx.accounts.program_sol_vault.to_account_info(),
                    &ctx.accounts.referrer_wallet.to_account_info(),
                    ctx.accounts.referrer.reserved_sol,
                    &[&[
                        b"program_sol_vault".as_ref(),
                        &[ctx.bumps.program_sol_vault]
                    ]],
                )?;
                
                // Zero out the reserved SOL value after payment
                ctx.accounts.referrer.reserved_sol = 0;
            }
            
            // Verify the token account is valid
            verify_token_account(
                &ctx.accounts.referrer_token_account.to_account_info(),
                &ctx.accounts.referrer_wallet.key(),
                &ctx.accounts.token_mint.key()
            )?;
            
            // Transfer the reserved tokens to the referrer using vault_authority
            if ctx.accounts.referrer.reserved_tokens > 0 {
                process_transfer_tokens(
                    &ctx.accounts.program_token_vault.to_account_info(),
                    &ctx.accounts.referrer_token_account.to_account_info(),
                    &ctx.accounts.vault_authority.to_account_info(),
                    &ctx.accounts.token_program,
                    ctx.accounts.referrer.reserved_tokens,
                    &[&[
                        b"token_vault_authority".as_ref(),
                        &[ctx.bumps.vault_authority]
                    ]],
                )?;
                // Add cleanup:
                force_memory_cleanup();
                
                // Zero out the reserved tokens value after payment
                ctx.accounts.referrer.reserved_tokens = 0;
            }
        }
        
        // Process the referrer's matrix
        let (chain_completed, upline_pubkey) = process_referrer_chain(
            &ctx.accounts.user_wallet.key(),
            &mut ctx.accounts.referrer,
            state.next_chain_id,
        )?;

        // Add cleanup:
        force_memory_cleanup();
        
        // If the matrix was completed, increment the global ID for the next one
        if chain_completed {
            state.next_chain_id += 1;
        }

        // If the referrer's matrix was completed, process recursion
        if chain_completed && slot_idx == 2 {
            let mut current_user_pubkey = upline_pubkey;
            let mut current_deposit = deposit_amount;
            let mut wsol_closed = false;

            // Calculate remaining accounts offset - skip the 4 vault A accounts and 2 Chainlink accounts
            let upline_start_idx = VAULT_A_ACCOUNTS_COUNT + 2;

            // Check if we have upline accounts to process (besides the 4 vault A accounts and 2 Chainlink accounts)
            if ctx.remaining_accounts.len() > upline_start_idx && current_deposit > 0 {
                let upline_accounts = &ctx.remaining_accounts[upline_start_idx..];
                
                // OPTIMIZATION - Check if remaining upline accounts are multiples of 3
                if upline_accounts.len() % 3 != 0 {
                    return Err(error!(ErrorCode::MissingUplineAccount));
                }
                
                // Calculate number of trios (PDA, wallet, ATA)
                let trio_count = upline_accounts.len() / 3;
                
                // OPTIMIZATION - Process in smaller batches to save memory
                const BATCH_SIZE: usize = 1; // Reduced from 2 to 1
                
                // Calculate number of batches (division with rounding up)
                let batch_count = (trio_count + BATCH_SIZE - 1) / BATCH_SIZE;
                
                // Process each batch
                for batch_idx in 0..batch_count {
                    // Calculate batch range
                    let start_trio = batch_idx * BATCH_SIZE;
                    let end_trio = std::cmp::min(start_trio + BATCH_SIZE, trio_count);
                    
                    // Iterate through trios in current batch
                    for trio_index in start_trio..end_trio {
                        // Check maximum depth and if deposit is remaining
                        if trio_index >= MAX_UPLINE_DEPTH || current_deposit == 0 {
                            break;
                        }

                        // Calculate base index for each trio
                        let base_idx = trio_index * 3;
                        
                        // Get current upline information
                        let upline_info = &upline_accounts[base_idx];       // Account PDA
                        let upline_wallet = &upline_accounts[base_idx + 1]; // Wallet 
                        let upline_token = &upline_accounts[base_idx + 2];  // ATA for tokens
                        
                        // OPTIMIZATION - Basic validations before processing the account
                        if upline_wallet.owner != &solana_program::system_program::ID {
                            return Err(error!(ErrorCode::PaymentWalletInvalid));
                        }
                        
                        // Check program ownership first before trying to deserialize
                        if !upline_info.owner.eq(&crate::ID) {
                            return Err(error!(ErrorCode::InvalidSlotOwner));
                        }

                        // STEP 1: Read and process data - Optimized for lower memory usage
                        let mut upline_account_data;
                        {
                            // Limited scope for data borrowing
                            let data = upline_info.try_borrow_data()?;
                            if data.len() <= 8 {
                                return Err(ProgramError::InvalidAccountData.into());
                            }

                            // Deserialize directly without clone
                            let mut account_slice = &data[8..];
                            upline_account_data = UserAccount::deserialize(&mut account_slice)?;

                            // Verify registration immediately
                            if !upline_account_data.is_registered {
                                return Err(error!(ErrorCode::SlotNotRegistered));
                            }
                        }

                        force_memory_cleanup();

                        // Continue processing with deserialized data
                        let upline_slot_idx = upline_account_data.chain.filled_slots as usize;
                        let upline_key = *upline_info.key;
                        
                        // Verify token account only if it's slot 3
                        if upline_slot_idx == 2 {
                            if upline_token.owner != &spl_token::id() {
                                return Err(error!(ErrorCode::TokenAccountInvalid));
                            }
                            
                            verify_token_account(
                                upline_token,
                                &upline_wallet.key(),
                                &ctx.accounts.token_mint.key()
                            )?;
                        }
                        
                        // Add current user to the matrix
                        upline_account_data.chain.slots[upline_slot_idx] = Some(current_user_pubkey);
                        
                        // Emit slot filled event in recursion
                        emit!(SlotFilled {
                            slot_idx: upline_slot_idx as u8,
                            chain_id: upline_account_data.chain.id,
                            user: current_user_pubkey,
                            owner: upline_key,
                        });
                        
                        // Increment filled slots count
                        upline_account_data.chain.filled_slots += 1;
                        
                        // Apply specific financial logic for the deposit
                        if upline_slot_idx == 0 {
                            // SLOT 1: Deposit to pool
                            // Use the WSOL account that was kept open
                            process_deposit_to_pool(
                                &ctx.accounts.user_wallet.to_account_info(),
                                &ctx.accounts.user_wsol_account.to_account_info(),
                                &ctx.accounts.b_vault_lp.to_account_info(),
                                &ctx.accounts.b_vault,
                                &ctx.accounts.b_token_vault.to_account_info(),
                                &ctx.accounts.b_vault_lp_mint.to_account_info(),
                                &ctx.accounts.vault_program,
                                &ctx.accounts.token_program,
                                current_deposit
                            )?;
                            
                            // Deposit was used, doesn't continue in recursion
                            current_deposit = 0;
                        } 
                        else if upline_slot_idx == 1 {
                            // SLOT 2: Reserve for upline (SOL and tokens)
                            // Close WSOL account if still open
                            if !wsol_closed {
                                let close_ix = spl_token::instruction::close_account(
                                    &token::ID,
                                    &ctx.accounts.user_wsol_account.key(),
                                    &ctx.accounts.user_wallet.key(),
                                    &ctx.accounts.user_wallet.key(),
                                    &[]
                                )?;
                                
                                let close_accounts = [
                                    ctx.accounts.user_wsol_account.to_account_info(),
                                    ctx.accounts.user_wallet.to_account_info(),
                                    ctx.accounts.user_wallet.to_account_info(),
                                ];
                                
                                solana_program::program::invoke(
                                    &close_ix,
                                    &close_accounts,
                                ).map_err(|_| error!(ErrorCode::UnwrapSolFailed))?;
                                
                                wsol_closed = true;
                            }
                            
                            // Now reserve the SOL
                            process_reserve_sol(
                                &ctx.accounts.user_wallet.to_account_info(),
                                &ctx.accounts.program_sol_vault.to_account_info(),
                                current_deposit
                            )?;
                            
                            // Update the reserved SOL value for the upline
                            upline_account_data.reserved_sol = current_deposit;
                            
                            // Calculate tokens based on pool value (using vault A accounts)
                            let token_amount = get_donut_tokens_amount(
                                a_vault_lp,
                                &ctx.accounts.b_vault_lp.to_account_info(),
                                a_vault_lp_mint,
                                &ctx.accounts.b_vault_lp_mint.to_account_info(),
                                a_token_vault,
                                &ctx.accounts.b_token_vault.to_account_info(),
                                current_deposit
                            )?;
                            
                            // Force cleanup after calculation
                            force_memory_cleanup();
                            
                            // Mint tokens for the program vault
                            process_mint_tokens(
                                &ctx.accounts.token_mint.to_account_info(),
                                &ctx.accounts.program_token_vault.to_account_info(),
                                &ctx.accounts.token_mint_authority.to_account_info(),
                                &ctx.accounts.token_program,
                                token_amount,
                                &[&[
                                    b"token_mint_authority".as_ref(),
                                    &[ctx.bumps.token_mint_authority]
                                ]],
                            )?;

                            force_memory_cleanup();
                            
                            // Update the reserved tokens value for the upline
                            upline_account_data.reserved_tokens = token_amount;
                            
                            // Deposit was reserved, doesn't continue in recursion
                            current_deposit = 0;
                        }
                        // SLOT 3: Pay reserved SOL and tokens to upline
                        else if upline_slot_idx == 2 {
                            // Pay reserved SOL
                            if upline_account_data.reserved_sol > 0 {
                                let reserved_sol = upline_account_data.reserved_sol;
                                
                                // Verify that wallet is a system account
                                if upline_wallet.owner != &solana_program::system_program::ID {
                                    return Err(error!(ErrorCode::PaymentWalletInvalid));
                                }
                                
                                // Create the transfer instruction
                                let ix = solana_program::system_instruction::transfer(
                                    &ctx.accounts.program_sol_vault.key(),
                                    &upline_wallet.key(),
                                    reserved_sol
                                );
                                
                                // Use Vec instead of array to avoid lifetime problems
                                let mut accounts = Vec::with_capacity(2);
                                accounts.push(ctx.accounts.program_sol_vault.to_account_info());
                                accounts.push(upline_wallet.clone());
                                
                                // Invoke the instruction with signature
                                solana_program::program::invoke_signed(
                                    &ix,
                                    &accounts,
                                    &[&[
                                        b"program_sol_vault".as_ref(),
                                        &[ctx.bumps.program_sol_vault]
                                    ]],
                                ).map_err(|_| error!(ErrorCode::ReferrerPaymentFailed))?;
                                
                                // Zero out the reserved SOL value
                                upline_account_data.reserved_sol = 0;
                            }
                            
                            // Pay reserved tokens
                            if upline_account_data.reserved_tokens > 0 {
                                let reserved_tokens = upline_account_data.reserved_tokens;
                                
                                // Verify if the token account is valid
                                if upline_token.owner != &spl_token::id() {
                                    return Err(error!(ErrorCode::TokenAccountInvalid));
                                }
                                
                                // Transfer tokens using function with individual parameters
                                process_transfer_tokens(
                                    &ctx.accounts.program_token_vault.to_account_info(),
                                    upline_token,
                                    &ctx.accounts.vault_authority.to_account_info(),
                                    &ctx.accounts.token_program,
                                    reserved_tokens,
                                    &[&[
                                        b"token_vault_authority".as_ref(),
                                        &[ctx.bumps.vault_authority]
                                    ]],
                                )?;
                                
                                // Add cleanup:
                                force_memory_cleanup();
                                
                                // Zero out the reserved tokens value after payment
                                upline_account_data.reserved_tokens = 0;
                            }
                        }
                        
                        // Check if matrix is complete
                        let chain_completed = upline_account_data.chain.filled_slots == 3;
                        
                        // Process matrix completion only if necessary
                        if chain_completed {
                            // Get new ID for the reset matrix
                            let next_chain_id_value = state.next_chain_id;
                            state.next_chain_id += 1;
                            
                            // Reset matrix with new ID
                            upline_account_data.chain.id = next_chain_id_value;
                            upline_account_data.chain.slots = [None, None, None];
                            upline_account_data.chain.filled_slots = 0;
                            
                            // Update current user for recursion
                            current_user_pubkey = upline_key;
                        }
                        
                        // STEP 2: Save changes back to the account
                        {
                            // New scope for mutable borrowing
                            let mut data = upline_info.try_borrow_mut_data()?;
                            let mut write_data = &mut data[8..];
                            upline_account_data.serialize(&mut write_data)?;
                        }

                        // Add cleanup:
                        force_memory_cleanup();
                        
                        // If matrix was not completed, stop processing here
                        if !chain_completed {
                            break;
                        }
                        
                        // Check maximum depth after processing
                        if trio_index >= MAX_UPLINE_DEPTH - 1 {
                            break;
                        }
                    }
                    
                    // Stop batch processing if no more deposits
                    if current_deposit == 0 {
                        break;
                    }
                }

                // Handle any remaining deposit
                if current_deposit > 0 {
                    // Deposit to pool if WSOL is still open
                    if !wsol_closed {
                        process_deposit_to_pool(
                            &ctx.accounts.user_wallet.to_account_info(),
                            &ctx.accounts.user_wsol_account.to_account_info(),
                            &ctx.accounts.b_vault_lp.to_account_info(),
                            &ctx.accounts.b_vault,
                            &ctx.accounts.b_token_vault.to_account_info(),
                            &ctx.accounts.b_vault_lp_mint.to_account_info(),
                            &ctx.accounts.vault_program,
                            &ctx.accounts.token_program,
                            current_deposit
                        )?;
                    }
                }
                
                // Close WSOL account if still open
                if !wsol_closed {
                    let account_info = ctx.accounts.user_wsol_account.to_account_info();
                    if account_info.data_len() > 0 {
                        let close_ix = spl_token::instruction::close_account(
                            &token::ID,
                            &ctx.accounts.user_wsol_account.key(),
                            &ctx.accounts.user_wallet.key(),
                            &ctx.accounts.user_wallet.key(),
                            &[]
                        )?;
                        
                        let close_accounts = [
                            ctx.accounts.user_wsol_account.to_account_info(),
                            ctx.accounts.user_wallet.to_account_info(),
                            ctx.accounts.user_wallet.to_account_info(),
                        ];
                        
                        solana_program::program::invoke(
                            &close_ix,
                            &close_accounts,
                        ).map_err(|_| error!(ErrorCode::UnwrapSolFailed))?;
                    }
                }
            }
        }

        Ok(())
    }
}