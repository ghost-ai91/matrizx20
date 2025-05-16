// registrar-multisig-duas-transacoes.js
const { Connection, Keypair, PublicKey, SystemProgram, Transaction, ComputeBudgetProgram } = require('@solana/web3.js');
const { Program, AnchorProvider, BN } = require('@coral-xyz/anchor');
const bs58 = require('bs58');
const fs = require('fs');

// Parâmetros principais
const PROGRAM_ID = new PublicKey("2SGUTp3c4oNUpTdsr1nEfp2j96VEyFVfQLqK7kNukHGk");
const STATE_ADDRESS = new PublicKey("4BEsGJgHdpGnvVyiNYE2LKVRfRij7mjrQyW6C51j1gS8");
const MULTISIG_TREASURY = new PublicKey("Eu22Js2qTu5bCr2WFY2APbvhDqAhUZpkYKmVsfeyqR2N");
const DEPOSIT_AMOUNT = 100_000_000; // 0.1 SOL

// Endereços importantes diretamente definidos
const TOKEN_PROGRAM_ID = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
const ASSOCIATED_TOKEN_PROGRAM_ID = new PublicKey("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");
const TOKEN_MINT = new PublicKey("51JpoNC5es8mpeRhPfTPcqMFzFhxeW3UrfvTmFnbw5G1");
const WSOL_MINT = new PublicKey("So11111111111111111111111111111111111111112");
const POOL_ADDRESS = new PublicKey("BEuzx33ecm4rtgjtB2bShqGco4zMkdr6ioyzPh6vY9ot");
const B_VAULT = new PublicKey("FERjPVNEa7Udq8CEv68h6tPL46Tq7ieE49HrE2wea3XT");
const B_TOKEN_VAULT = new PublicKey("HZeLxbZ9uHtSpwZC3LBr4Nubd14iHwz7bRSghRZf5VCG");
const B_VAULT_LP_MINT = new PublicKey("BvoAjwEDhpLzs3jtu4H72j96ShKT5rvZE9RP1vgpfSM");
const B_VAULT_LP = new PublicKey("8mNjx5Aww9DX33uFxZwqb7m2vhsavrxyzkME3hE63sT2");
const VAULT_PROGRAM = new PublicKey("24Uqj9JCLxUeoC3hGfh5W3s9FM9uCHDS2SG3LYwBpyTi");
const RENT_SYSVAR = new PublicKey("SysvarRent111111111111111111111111111111111");
const CHAINLINK_PROGRAM = new PublicKey("HEvSKofvBgfaexv23kMabbYqxasxU3mQ4ibBMEmJWHny");
const SOL_USD_FEED = new PublicKey("99B2bTijsU6f1GCT73HmdR7HCFFjGMBcPZY6jZ96ynrR");
const A_VAULT_LP = new PublicKey("BGh2tc4kagmEmVvaogdcAodVDvUxmXWivYL5kxwapm31");
const A_VAULT_LP_MINT = new PublicKey("Bk33KwVZ8hsgr3uSb8GGNJZpAEqH488oYPvoY5W9djVP");
const A_TOKEN_VAULT = new PublicKey("HoASBFustFYysd9aCu6M3G3kve88j22LAyTpvCNp5J65");

async function main() {
  try {
    console.log("🚀 PREPARANDO REGISTRO DO MULTISIG EM DUAS TRANSAÇÕES 🚀");
    
    // Conectar à devnet
    const connection = new Connection('https://weathered-quiet-theorem.solana-devnet.quiknode.pro/198997b67cb51804baeb34ed2257274aa2b2d8c0', 'confirmed');
    
    // Carregar IDL
    let idl;
    try {
      idl = require('./target/idl/referral_system.json');
      console.log("✅ IDL carregado com sucesso");
    } catch (e) {
      console.error("❌ Erro ao carregar IDL:", e.message);
      return;
    }
    
    // Derivar PDA da conta do usuário (usando MULTISIG_TREASURY como userWallet)
    const [userPDA] = PublicKey.findProgramAddressSync(
      [Buffer.from("user_account"), MULTISIG_TREASURY.toBuffer()],
      PROGRAM_ID
    );
    console.log("📄 Conta do usuário (PDA): " + userPDA.toString());
    
    // Determinar endereço ATA WSOL para a multisig treasury
    const userWsolATA = PublicKey.findProgramAddressSync(
      [
        MULTISIG_TREASURY.toBuffer(),
        TOKEN_PROGRAM_ID.toBuffer(),
        WSOL_MINT.toBuffer()
      ],
      ASSOCIATED_TOKEN_PROGRAM_ID
    )[0];
    console.log("💰 ATA WSOL da multisig: " + userWsolATA.toString());
    
    // Configurar provider
    const provider = new AnchorProvider(
      connection,
      {
        publicKey: MULTISIG_TREASURY,
        signTransaction: () => {},
        signAllTransactions: () => {}
      },
      { commitment: 'confirmed' }
    );
    
    // Inicializar programa
    const program = new Program(idl, PROGRAM_ID, provider);
    console.log("✅ Programa inicializado");
    
    // ========= PRIMEIRA TRANSAÇÃO: CRIAR ATA WSOL ==========
    console.log("\n📝 GERANDO PRIMEIRA TRANSAÇÃO: CRIAR ATA WSOL");
    
    // Instrução para criar ATA WSOL
    const createATAIx = {
      programId: ASSOCIATED_TOKEN_PROGRAM_ID,
      keys: [
        { pubkey: MULTISIG_TREASURY, isSigner: true, isWritable: true },
        { pubkey: userWsolATA, isSigner: false, isWritable: true },
        { pubkey: MULTISIG_TREASURY, isSigner: false, isWritable: false },
        { pubkey: WSOL_MINT, isSigner: false, isWritable: false },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
        { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
        { pubkey: RENT_SYSVAR, isSigner: false, isWritable: false }
      ],
      data: Buffer.from([0]) // Código de instrução CreateAssociatedTokenAccount
    };
    
    // Criar a primeira transação
    const tx1 = new Transaction();
    tx1.add(createATAIx);
    
    // Adicionar blockhash recente
    const { blockhash: blockhash1 } = await connection.getLatestBlockhash('confirmed');
    tx1.recentBlockhash = blockhash1;
    tx1.feePayer = MULTISIG_TREASURY;
    
    // Serializar transação para base58
    const serializedTx1 = tx1.serialize({
      requireAllSignatures: false,
      verifySignatures: false
    });
    const base58Tx1 = bs58.encode(serializedTx1);
    
    // Salvar primeira transação
    fs.writeFileSync('tx1-criar-ata-wsol.txt', base58Tx1);
    console.log("✅ Primeira transação salva em 'tx1-criar-ata-wsol.txt'");
    
    // ========= SEGUNDA TRANSAÇÃO: REGISTRO + TRANSFERÊNCIA + SYNC ==========
    console.log("\n📝 GERANDO SEGUNDA TRANSAÇÃO: REGISTRO + OPERAÇÕES WSOL");
    
    // Remaining accounts para o Vault A e Chainlink
    const remainingAccounts = [
      {pubkey: A_VAULT_LP, isWritable: true, isSigner: false},
      {pubkey: A_VAULT_LP_MINT, isWritable: true, isSigner: false},
      {pubkey: A_TOKEN_VAULT, isWritable: true, isSigner: false},
      {pubkey: SOL_USD_FEED, isWritable: false, isSigner: false},
      {pubkey: CHAINLINK_PROGRAM, isWritable: false, isSigner: false},
    ];
    
    // Instrução para transferir SOL para a ATA WSOL
    const transferSolToWsolIx = SystemProgram.transfer({
      fromPubkey: MULTISIG_TREASURY,
      toPubkey: userWsolATA,
      lamports: DEPOSIT_AMOUNT
    });
    
    // Instrução para sincronizar a conta WSOL
    const syncNativeIx = {
      programId: TOKEN_PROGRAM_ID,
      keys: [
        { pubkey: userWsolATA, isSigner: false, isWritable: true }
      ],
      data: Buffer.from([17]) // SyncNative instruction code
    };
    
    // Aumentar compute units
    const modifyComputeUnits = ComputeBudgetProgram.setComputeUnitLimit({
      units: 1_000_000
    });
    
    // Aumentar prioridade da transação
    const setPriority = ComputeBudgetProgram.setComputeUnitPrice({
      microLamports: 5000
    });
    
    try {
      // Gerar instrução de registro
      const registerIx = await program.methods
        .registerWithoutReferrer(new BN(DEPOSIT_AMOUNT))
        .accounts({
          state: STATE_ADDRESS,
          owner: MULTISIG_TREASURY,
          userWallet: MULTISIG_TREASURY,
          user: userPDA,
          userWsolAccount: userWsolATA,
          wsolMint: WSOL_MINT,
          pool: POOL_ADDRESS,
          bVault: B_VAULT,
          bTokenVault: B_TOKEN_VAULT,
          bVaultLpMint: B_VAULT_LP_MINT,
          bVaultLp: B_VAULT_LP,
          vaultProgram: VAULT_PROGRAM,
          tokenMint: TOKEN_MINT,
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
          associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        })
        .remainingAccounts(remainingAccounts)
        .instruction();
      
      // Criar segunda transação
      const tx2 = new Transaction();
      tx2.add(modifyComputeUnits);
      tx2.add(setPriority);
      tx2.add(transferSolToWsolIx);
      tx2.add(syncNativeIx);
      tx2.add(registerIx);
      
      // Adicionar blockhash recente
      const { blockhash: blockhash2 } = await connection.getLatestBlockhash('confirmed');
      tx2.recentBlockhash = blockhash2;
      tx2.feePayer = MULTISIG_TREASURY;
      
      // Serializar transação para base58
      const serializedTx2 = tx2.serialize({
        requireAllSignatures: false,
        verifySignatures: false
      });
      const base58Tx2 = bs58.encode(serializedTx2);
      
      // Salvar segunda transação
      fs.writeFileSync('tx2-registro-usuario-base.txt', base58Tx2);
      console.log("✅ Segunda transação salva em 'tx2-registro-usuario-base.txt'");
      
      // Salvar informações gerais em JSON
      const txData = {
        transacao1: {
          descricao: "Criar ATA WSOL para a multisig treasury",
          base58Transaction: base58Tx1,
          instrucoesIncluidas: ["createAssociatedTokenAccount"]
        },
        transacao2: {
          descricao: "Transferir SOL, sincronizar e registrar usuário base",
          base58Transaction: base58Tx2,
          instrucoesIncluidas: ["setComputeUnitLimit", "setComputeUnitPrice", "transfer", "syncNative", "registerWithoutReferrer"]
        },
        informacoes: {
          multisigTreasury: MULTISIG_TREASURY.toString(),
          userPDA: userPDA.toString(),
          userWsolATA: userWsolATA.toString(),
          stateAddress: STATE_ADDRESS.toString(),
          programId: PROGRAM_ID.toString(),
          depositAmount: DEPOSIT_AMOUNT,
        }
      };
      
      fs.writeFileSync('registro-multisig-duas-transacoes.json', JSON.stringify(txData, null, 2));
      console.log("✅ Dados JSON salvos em 'registro-multisig-duas-transacoes.json'");
      
      // Exibir informações para o usuário
      console.log("\n🔹 TRANSAÇÃO 1 (CRIAR ATA WSOL) EM BASE58:");
      console.log(base58Tx1);
      
      console.log("\n🔹 TRANSAÇÃO 2 (REGISTRO) EM BASE58:");
      console.log(base58Tx2);
      
      console.log("\n⚠️ INSTRUÇÕES PARA USO NO SQUADS:");
      console.log("PASSO 1: Criar a ATA WSOL");
      console.log("1. Acesse o Squads: https://app.squads.so");
      console.log("2. Conecte a carteira associada ao multisig Treasury");
      console.log("3. Crie uma nova transação usando 'Import from base58'");
      console.log("4. Cole a string base58 da primeira transação");
      console.log("5. Colete as assinaturas necessárias e execute esta transação");
      console.log("6. AGUARDE a confirmação da primeira transação antes de prosseguir");
      
      console.log("\nPASSO 2: Registrar o usuário base");
      console.log("1. SOMENTE APÓS a primeira transação ser confirmada, crie uma nova transação");
      console.log("2. Use 'Import from base58' novamente");
      console.log("3. Cole a string base58 da segunda transação");
      console.log("4. Colete as assinaturas necessárias e execute a segunda transação");
      
      console.log("\n📋 RESUMO DAS INFORMAÇÕES:");
      console.log("🏦 Multisig Treasury: " + MULTISIG_TREASURY.toString());
      console.log("📄 PDA da conta do usuário: " + userPDA.toString());
      console.log("💰 ATA WSOL: " + userWsolATA.toString());
      console.log("💰 Valor de depósito: " + DEPOSIT_AMOUNT / 1_000_000_000 + " SOL");
      
    } catch (e) {
      console.error("❌ Erro ao gerar instrução:", e);
      
      // Tentar obter mais informações
      console.error("\nDetalhes do erro:");
      console.error(e.message);
      if (e.logs) {
        console.error("\nLogs de erro:");
        e.logs.forEach((log, i) => console.error(`${i}: ${log}`));
      }
    }
    
  } catch (error) {
    console.error("❌ ERRO GERAL DURANTE O PROCESSO:", error);
  }
}

main();