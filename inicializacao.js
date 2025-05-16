// criar-estado.js
const { Connection, Keypair, PublicKey, SystemProgram, Transaction, sendAndConfirmTransaction } = require('@solana/web3.js');
const { Program, AnchorProvider, utils, web3 } = require('@coral-xyz/anchor');
const bs58 = require('bs58'); // Você precisará instalar: npm install bs58
const fs = require('fs');
const path = require('path');

// Receber parâmetros da linha de comando
const args = process.argv.slice(2);
const walletPath = args[0] || '/root/.config/solana/id.json'; // Caminho padrão se não for fornecido
const multisigAddress = args[1] || 'Eu22Js2qTu5bCr2WFY2APbvhDqAhUZpkYKmVsfeyqR2N'; // Endereço da multisig Treasury
const configOutputPath = args[2] || './multisig-initialize-data.json';

// Configurações principais
const PROGRAM_ID = new PublicKey("2SGUTp3c4oNUpTdsr1nEfp2j96VEyFVfQLqK7kNukHGk");
const TOKEN_MINT = new PublicKey("51JpoNC5es8mpeRhPfTPcqMFzFhxeW3UrfvTmFnbw5G1");

// Função para carregar uma carteira a partir de um arquivo
function loadWalletFromFile(filePath) {
  if (!fs.existsSync(filePath)) {
    throw new Error(`Arquivo de carteira não encontrado: ${filePath}`);
  }
  return Keypair.fromSecretKey(
    Uint8Array.from(JSON.parse(fs.readFileSync(filePath, 'utf-8')))
  );
}

async function main() {
  try {
    console.log("🚀 ETAPA 1: CRIANDO CONTA DE ESTADO PARA INICIALIZAÇÃO VIA MULTISIG 🚀");
    console.log("===============================================================");
    console.log(`Usando arquivo de carteira: ${walletPath}`);
    console.log(`Endereço da multisig Treasury: ${multisigAddress}`);
    
    // Conectar à devnet
    const connection = new Connection('https://weathered-quiet-theorem.solana-devnet.quiknode.pro/198997b67cb51804baeb34ed2257274aa2b2d8c0', 'confirmed');
    console.log('Conectando à Devnet');
    
    // Carregar carteira local para operações
    let walletKeypair;
    try {
      walletKeypair = loadWalletFromFile(walletPath);
      console.log("👤 Endereço da carteira local: " + walletKeypair.publicKey.toString());
    } catch (e) {
      console.error(`❌ Erro ao carregar carteira: ${e.message}`);
      return;
    }
    
    // Verificar saldo da carteira
    const balance = await connection.getBalance(walletKeypair.publicKey);
    console.log(`💰 Saldo da carteira local: ${balance / 1_000_000_000} SOL`);
    
    if (balance < 1_000_000_000) {
      console.warn("⚠️ Saldo baixo! Recomendamos pelo menos 1 SOL para o processo.");
      console.log("⚠️ Use o faucet da Devnet para obter SOL: https://faucet.solana.com");
      const continueAnyway = await new Promise(resolve => {
        process.stdout.write("Continuar mesmo assim? (s/n): ");
        process.stdin.once('data', data => {
          resolve(data.toString().trim().toLowerCase() === 's');
        });
      });
      
      if (!continueAnyway) {
        console.log("Operação cancelada pelo usuário.");
        return;
      }
    }
    
    // Configurar o provider com a carteira local
    const provider = new AnchorProvider(
      connection, 
      { 
        publicKey: walletKeypair.publicKey, 
        signTransaction: async (tx) => {
          tx.partialSign(walletKeypair);
          return tx;
        }, 
        signAllTransactions: async (txs) => {
          return txs.map(tx => {
            tx.partialSign(walletKeypair);
            return tx;
          });
        }
      },
      { commitment: 'confirmed' }
    );
    
    // Inicializar o programa
    const program = new Program(require('./target/idl/referral_system.json'), PROGRAM_ID, provider);
    
    // Gerar um novo keypair para o estado
    const stateKeypair = Keypair.generate();
    console.log("🔑 Novo endereço de estado: " + stateKeypair.publicKey.toString());
    
    // Calcular espaço e rent para a conta de estado
    const space = 8 + 32 + 4 + 4; // 8 bytes discriminator + 32 bytes owner + 4 bytes nextUplineId + 4 bytes nextChainId
    const rent = await connection.getMinimumBalanceForRentExemption(space);
    console.log("💰 Rent necessário: " + rent / 1_000_000_000 + " SOL");
    
    // Criar a transação para a conta de estado
    console.log("\n📝 CRIANDO A CONTA DE ESTADO...");
    try {
      // Criar instrução para criação da conta
      const createAccountIx = SystemProgram.createAccount({
        fromPubkey: walletKeypair.publicKey, // A carteira LOCAL paga e assina
        newAccountPubkey: stateKeypair.publicKey,
        lamports: rent,
        space: space,
        programId: PROGRAM_ID // A conta pertencerá ao programa
      });
      
      // Criar e enviar a transação
      const tx = new Transaction().add(createAccountIx);
      const signature = await sendAndConfirmTransaction(
        connection,
        tx,
        [walletKeypair, stateKeypair] // Ambos assinam: a carteira local e o estado
      );
      
      console.log("✅ CONTA DE ESTADO CRIADA COM SUCESSO: " + signature);
      console.log(`🔍 Link para explorador: https://explorer.solana.com/tx/${signature}?cluster=devnet`);
      
      // Agora vamos preparar os dados para a multisig executar a inicialização
      console.log("\n📝 PREPARANDO DADOS PARA INICIALIZAÇÃO VIA MULTISIG...");
      
      // Configurar provider temporário usando a multisig
      const multisigProvider = new AnchorProvider(
        connection,
        {
          publicKey: new PublicKey(multisigAddress),
          signTransaction: () => {},
          signAllTransactions: () => {}
        },
        { commitment: 'confirmed' }
      );
      
      // Reinicializar o programa com o provider da multisig
      const multisigProgram = new Program(require('./target/idl/referral_system.json'), PROGRAM_ID, multisigProvider);
      
      // Gerar instrução de inicialização (apenas a inicialização, não a criação da conta)
      const initializeIx = await multisigProgram.methods
        .initialize()
        .accounts({
          state: stateKeypair.publicKey,
          owner: new PublicKey(multisigAddress), // A multisig será o owner
          systemProgram: SystemProgram.programId,
        })
        .instruction();
      
      // Criar transação apenas com a inicialização
      const initializeTx = new Transaction();
      initializeTx.add(initializeIx);
      initializeTx.feePayer = new PublicKey(multisigAddress);
      const blockhash = await connection.getRecentBlockhash('confirmed');
      initializeTx.recentBlockhash = blockhash.blockhash;
      
      // Serializar transação para formato base58
      const serializedTx = initializeTx.serialize({
        requireAllSignatures: false,
        verifySignatures: false
      });
      const base58Tx = bs58.encode(serializedTx);
      
      // Dados de instrução em base58 para Custom Instructions
      const initializeDataBase58 = bs58.encode(initializeIx.data);
      
      // Derivar PDAs importantes para referência
      console.log("\n🔑 PDAS IMPORTANTES PARA REFERÊNCIA:");
      
      // PDA para autoridade de mintagem
      const [tokenMintAuthority, tokenMintAuthorityBump] = PublicKey.findProgramAddressSync(
        [Buffer.from("token_mint_authority")],
        PROGRAM_ID
      );
      console.log("🔑 PDA Mint Authority: " + tokenMintAuthority.toString() + " (Bump: " + tokenMintAuthorityBump + ")");
      
      // PDA para vault de SOL
      const [programSolVault, programSolVaultBump] = PublicKey.findProgramAddressSync(
        [Buffer.from("program_sol_vault")],
        PROGRAM_ID
      );
      console.log("💰 PDA do Vault de SOL: " + programSolVault.toString() + " (Bump: " + programSolVaultBump + ")");
      
      // PDA para autoridade do vault de tokens
      const [vaultAuthority, vaultAuthorityBump] = PublicKey.findProgramAddressSync(
        [Buffer.from("token_vault_authority")],
        PROGRAM_ID
      );
      console.log("🔑 PDA do Vault Authority: " + vaultAuthority.toString() + " (Bump: " + vaultAuthorityBump + ")");
      
      // Calcular ATA do vault de tokens
      const programTokenVault = utils.token.associatedAddress({
        mint: TOKEN_MINT,
        owner: vaultAuthority
      });
      console.log("💰 ATA do Vault de Tokens: " + programTokenVault.toString());
      
      // Salvar os dados para uso com Squads
      const squadsData = {
        // Dados da transação para Squads
        transaction: {
          base58Transaction: base58Tx,
          customInstruction: {
            programId: PROGRAM_ID.toString(),
            accounts: [
              {
                pubkey: stateKeypair.publicKey.toString(),
                isSigner: false, // Agora não precisa mais ser signatário!
                isWritable: true
              },
              {
                pubkey: multisigAddress,
                isSigner: true,
                isWritable: true
              },
              {
                pubkey: SystemProgram.programId.toString(),
                isSigner: false,
                isWritable: false
              }
            ],
            dataBase58: initializeDataBase58
          }
        },
        
        // Informações importantes
        statePublicKey: stateKeypair.publicKey.toString(),
        statePrivateKeyBase58: bs58.encode(Buffer.from(stateKeypair.secretKey)), // Mantido apenas para referência futura
        programID: PROGRAM_ID.toString(),
        multisigTreasury: multisigAddress,
        tokenMint: TOKEN_MINT.toString(),
        tokenMintAuthority: tokenMintAuthority.toString(),
        tokenMintAuthorityBump,
        programSolVault: programSolVault.toString(),
        programSolVaultBump,
        vaultAuthority: vaultAuthority.toString(),
        vaultAuthorityBump,
        programTokenVault: programTokenVault.toString()
      };
      
      // Criar diretório para o arquivo de configuração se não existir
      const configDir = path.dirname(configOutputPath);
      if (!fs.existsSync(configDir)) {
        fs.mkdirSync(configDir, { recursive: true });
      }
      
      // Salvar os dados
      fs.writeFileSync(configOutputPath, JSON.stringify(squadsData, null, 2));
      console.log(`\n💾 Dados para inicialização via Squads salvos em: ${configOutputPath}`);
      
      // Exibir instruções para uso no Squads
      console.log("\n⚠️ INSTRUÇÕES PARA USO NO SQUADS:");
      console.log("1. Acesse o Squads: https://app.squads.so");
      console.log("2. Conecte a carteira associada ao multisig Treasury");
      console.log("3. Crie uma nova transação usando 'Import from base58'");
      console.log("4. Cole a string base58 abaixo:");
      console.log(base58Tx);
      console.log("5. Esta transação NÃO requer a assinatura do estado, apenas da multisig");
      console.log("6. Colete as assinaturas necessárias e execute a transação");
      
      console.log("\nMÉTODO ALTERNATIVO - Usando Custom Instructions:");
      console.log("Se preferir usar 'Custom Instructions', use os seguintes valores:");
      console.log("- ProgramID: " + PROGRAM_ID.toString());
      console.log("- Dados (Raw): " + initializeDataBase58);
      console.log("- Contas: Verifique o arquivo de configuração para detalhes");
      
      console.log("\n⚠️ IMPORTANTE: Guarde estes endereços para uso futuro!");
      console.log("🔑 ENDEREÇO DO PROGRAMA: " + PROGRAM_ID.toString());
      console.log("🔑 ESTADO DO PROGRAMA: " + stateKeypair.publicKey.toString());
      console.log("🔑 OWNER DO PROGRAMA: " + multisigAddress);
      
    } catch (error) {
      console.error("❌ ERRO DURANTE O PROCESSO:", error);
      
      // Exibir detalhes do erro para diagnóstico
      if (error.logs) {
        console.log("\n📋 LOGS DE ERRO:");
        error.logs.forEach((log, i) => console.log(`${i}: ${log}`));
      }
    }
  } catch (error) {
    console.error("❌ ERRO GERAL:", error);
  } finally {
    process.exit(0);
  }
}

main();