// prepare-register-base-user-v2.js
const { Connection, Keypair, PublicKey, SystemProgram, ComputeBudgetProgram } = require('@solana/web3.js');
const { Program, AnchorProvider, BN, utils } = require('@coral-xyz/anchor');
const { ASSOCIATED_TOKEN_PROGRAM_ID, TOKEN_PROGRAM_ID } = require('@solana/spl-token');
const fs = require('fs');

// Parâmetros
const PROGRAM_ID = new PublicKey("2SGUTp3c4oNUpTdsr1nEfp2j96VEyFVfQLqK7kNukHGk");
const STATE_ADDRESS = new PublicKey("ENDERECO_DO_ESTADO"); // Do processo de inicialização
const MULTISIG_TREASURY = new PublicKey("Eu22Js2qTu5bCr2WFY2APbvhDqAhUZpkYKmVsfeyqR2N");

// Configurações de endereços
const TOKEN_MINT = new PublicKey("51JpoNC5es8mpeRhPfTPcqMFzFhxeW3UrfvTmFnbw5G1");
const WSOL_MINT = new PublicKey("So11111111111111111111111111111111111111112");
const POOL_ADDRESS = new PublicKey("BEuzx33ecm4rtgjtB2bShqGco4zMkdr6ioyzPh6vY9ot");
const A_VAULT_LP = new PublicKey("BGh2tc4kagmEmVvaogdcAodVDvUxmXWivYL5kxwapm31");
const A_VAULT_LP_MINT = new PublicKey("Bk33KwVZ8hsgr3uSb8GGNJZpAEqH488oYPvoY5W9djVP");
const A_TOKEN_VAULT = new PublicKey("HoASBFustFYysd9aCu6M3G3kve88j22LAyTpvCNp5J65");
const B_VAULT = new PublicKey("FERjPVNEa7Udq8CEv68h6tPL46Tq7ieE49HrE2wea3XT");
const B_TOKEN_VAULT = new PublicKey("HZeLxbZ9uHtSpwZC3LBr4Nubd14iHwz7bRSghRZf5VCG");
const B_VAULT_LP_MINT = new PublicKey("BvoAjwEDhpLzs3jtu4H72j96ShKT5rvZE9RP1vgpfSM");
const B_VAULT_LP = new PublicKey("8mNjx5Aww9DX33uFxZwqb7m2vhsavrxyzkME3hE63sT2");
const VAULT_PROGRAM = new PublicKey("24Uqj9JCLxUeoC3hGfh5W3s9FM9uCHDS2SG3LYwBpyTi");
const CHAINLINK_PROGRAM = new PublicKey("HEvSKofvBgfaexv23kMabbYqxasxU3mQ4ibBMEmJWHny");
const SOL_USD_FEED = new PublicKey("99B2bTijsU6f1GCT73HmdR7HCFFjGMBcPZY6jZ96ynrR");
const SYSTEM_PROGRAM_ID = new PublicKey("11111111111111111111111111111111");
const SYSVAR_RENT_PUBKEY = new PublicKey("SysvarRent111111111111111111111111111111111");

// Valor do depósito (0.1 SOL)
const DEPOSIT_AMOUNT = 100_000_000;

async function main() {
  try {
    console.log("🚀 PREPARANDO REGISTRO DO MULTISIG COMO USUÁRIO BASE (V2) 🚀");
    
    // Conectar à mainnet
    const connection = new Connection('https://api.mainnet-beta.solana.com', 'confirmed');
    
    // Carregar IDL
    const idl = require('./target/idl/referral_system.json');
    
    // Derivar PDA da conta do usuário (usando MULTISIG_TREASURY como userWallet)
    const [userAccount] = PublicKey.findProgramAddressSync(
      [Buffer.from("user_account"), MULTISIG_TREASURY.toBuffer()],
      PROGRAM_ID
    );
    console.log("📄 CONTA DO USUÁRIO (PDA): " + userAccount.toString());
    
    // Determinar conta WSOL ATA para o multisig
    const userWsolAccount = await utils.token.associatedAddress({
      mint: WSOL_MINT,
      owner: MULTISIG_TREASURY
    });
    console.log("💰 WSOL ATA do multisig: " + userWsolAccount.toString());
    
    // Configurar provider temporário
    const provider = new AnchorProvider(
      connection,
      {
        publicKey: MULTISIG_TREASURY,
        signTransaction: () => {},
        signAllTransactions: () => {}
      },
      {}
    );
    
    // Inicializar o programa
    const program = new Program(idl, PROGRAM_ID, provider);
    
    // === CRIAR INSTRUÇÕES PARA O MULTISIG ===
    
    // Instrução para criar a conta ATA WSOL para o MULTISIG_TREASURY
    const createATAIx = {
      programId: ASSOCIATED_TOKEN_PROGRAM_ID,
      keys: [
        { pubkey: MULTISIG_TREASURY, isSigner: true, isWritable: true }, // Pagador
        { pubkey: userWsolAccount, isSigner: false, isWritable: true },  // ATA a ser criada
        { pubkey: MULTISIG_TREASURY, isSigner: false, isWritable: false }, // Dono da ATA (agora é o multisig)
        { pubkey: WSOL_MINT, isSigner: false, isWritable: false },
        { pubkey: SYSTEM_PROGRAM_ID, isSigner: false, isWritable: false },
        { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
        { pubkey: SYSVAR_RENT_PUBKEY, isSigner: false, isWritable: false }
      ],
      data: Buffer.from([0]) // CreateAssociatedTokenAccount instruction code
    };
    
    // Instrução para transferir SOL para a conta WSOL
    const transferSolToWsolIx = SystemProgram.transfer({
      fromPubkey: MULTISIG_TREASURY,
      toPubkey: userWsolAccount,
      lamports: DEPOSIT_AMOUNT
    });
    
    // Instrução para sincronizar a conta WSOL
    const syncNativeIx = {
      programId: TOKEN_PROGRAM_ID,
      keys: [
        { pubkey: userWsolAccount, isSigner: false, isWritable: true }
      ],
      data: Buffer.from([17]) // SyncNative instruction code
    };
    
    // Remaining accounts para o Vault A e Chainlink
    const remainingAccounts = [
      {pubkey: A_VAULT_LP, isWritable: true, isSigner: false},
      {pubkey: A_VAULT_LP_MINT, isWritable: true, isSigner: false},
      {pubkey: A_TOKEN_VAULT, isWritable: true, isSigner: false},
      {pubkey: SOL_USD_FEED, isWritable: false, isSigner: false},
      {pubkey: CHAINLINK_PROGRAM, isWritable: false, isSigner: false},
    ];
    
    // Gerar a instrução de register_without_referrer
    // Agora usando MULTISIG_TREASURY como owner E userWallet
    const registerIx = await program.methods
      .registerWithoutReferrer(new BN(DEPOSIT_AMOUNT))
      .accounts({
        state: STATE_ADDRESS,
        owner: MULTISIG_TREASURY,
        userWallet: MULTISIG_TREASURY, // Agora usando multisig como userWallet
        user: userAccount,
        userWsolAccount: userWsolAccount,
        wsolMint: WSOL_MINT,
        pool: POOL_ADDRESS,
        bVault: B_VAULT,
        bTokenVault: B_TOKEN_VAULT,
        bVaultLpMint: B_VAULT_LP_MINT,
        bVaultLp: B_VAULT_LP,
        vaultProgram: VAULT_PROGRAM,
        tokenMint: TOKEN_MINT,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SYSTEM_PROGRAM_ID,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        rent: SYSVAR_RENT_PUBKEY
      })
      .remainingAccounts(remainingAccounts)
      .instruction();
    
    // Aumentar o limite de compute units
    const modifyComputeUnits = ComputeBudgetProgram.setComputeUnitLimit({
      units: 1_000_000
    });
    
    // Aumentar a prioridade da transação
    const setPriority = ComputeBudgetProgram.setComputeUnitPrice({
      microLamports: 5000
    });
    
    // Converter instruções para formato JSON
    const squadsInstructions = [
      {
        programId: ComputeBudgetProgram.programId.toString(),
        accounts: modifyComputeUnits.keys.map(key => ({
          pubkey: key.pubkey.toString(),
          isSigner: key.isSigner,
          isWritable: key.isWritable
        })),
        data: Buffer.from(modifyComputeUnits.data).toString('base64')
      },
      {
        programId: ComputeBudgetProgram.programId.toString(),
        accounts: setPriority.keys.map(key => ({
          pubkey: key.pubkey.toString(),
          isSigner: key.isSigner,
          isWritable: key.isWritable
        })),
        data: Buffer.from(setPriority.data).toString('base64')
      },
      {
        programId: ASSOCIATED_TOKEN_PROGRAM_ID.toString(),
        accounts: createATAIx.keys.map(key => ({
          pubkey: key.pubkey.toString(),
          isSigner: key.isSigner,
          isWritable: key.isWritable
        })),
        data: Buffer.from(createATAIx.data).toString('base64')
      },
      {
        programId: SYSTEM_PROGRAM_ID.toString(),
        accounts: transferSolToWsolIx.keys.map(key => ({
          pubkey: key.pubkey.toString(),
          isSigner: key.isSigner,
          isWritable: key.isWritable
        })),
        data: Buffer.from(transferSolToWsolIx.data).toString('base64')
      },
      {
        programId: TOKEN_PROGRAM_ID.toString(),
        accounts: syncNativeIx.keys.map(key => ({
          pubkey: key.pubkey.toString(),
          isSigner: key.isSigner,
          isWritable: key.isWritable
        })),
        data: Buffer.from(syncNativeIx.data).toString('base64')
      },
      {
        programId: PROGRAM_ID.toString(),
        accounts: registerIx.keys.map(key => ({
          pubkey: key.pubkey.toString(),
          isSigner: key.isSigner,
          isWritable: key.isWritable
        })),
        data: Buffer.from(registerIx.data).toString('base64'),
        remainingAccounts: remainingAccounts.map(acc => ({
          pubkey: acc.pubkey.toString(),
          isSigner: acc.isSigner,
          isWritable: acc.isWritable
        }))
      }
    ];
    
    // Preparar dados para o Squads
    const squadsData = {
      instructions: squadsInstructions,
      programID: PROGRAM_ID.toString(),
      multisigTreasury: MULTISIG_TREASURY.toString(),
      userAccount: userAccount.toString(),
      userWsolAccount: userWsolAccount.toString(),
      depositAmount: DEPOSIT_AMOUNT
    };
    
    // Salvar dados para uso no Squads
    fs.writeFileSync(
      `squads-register-multisig-user-v2-${MULTISIG_TREASURY.toString().substring(0, 8)}.json`,
      JSON.stringify(squadsData, null, 2)
    );
    
    console.log("\n💾 Dados para Squads salvos");
    console.log("\n⚠️ IMPORTANTE: INSTRUÇÕES PARA REGISTRO VIA MULTISIG");
    console.log("1. Acesse o Squads: https://app.squads.so");
    console.log("2. Conecte a carteira associada ao multisig Treasury");
    console.log("3. Crie uma nova transação usando 'Custom Instructions'");
    console.log("4. Adicione as instruções conforme o JSON gerado");
    console.log("5. Colete as assinaturas necessárias e execute a transação");
    console.log("\n📋 RESUMO DAS INFORMAÇÕES:");
    console.log("🏦 Multisig Treasury (owner e userWallet): " + MULTISIG_TREASURY.toString());
    console.log("📄 PDA da conta do usuário: " + userAccount.toString());
    console.log("💰 Conta WSOL ATA: " + userWsolAccount.toString());
    console.log("💰 Valor de depósito: " + DEPOSIT_AMOUNT / 1_000_000_000 + " SOL");
    
  } catch (error) {
    console.error("❌ ERRO DURANTE O PROCESSO:", error);
    console.error(error);
  }
}

main();