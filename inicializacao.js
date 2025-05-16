// inicializacao.js
const { Connection, Keypair, PublicKey, SystemProgram, Transaction } = require('@solana/web3.js');
const { AnchorProvider, Program, utils } = require('@coral-xyz/anchor');
const fs = require('fs');
const path = require('path');

// Receber parâmetros da linha de comando
const args = process.argv.slice(2);
const walletPath = args[0] || '/root/.config/solana/id.json'; // Caminho padrão se não for fornecido
const configOutputPath = args[1] || './matriz-config.json';

// Carregue seu IDL compilado
const idl = require('./target/idl/referral_system.json');

// Configurações principais
const PROGRAM_ID = new PublicKey("2SGUTp3c4oNUpTdsr1nEfp2j96VEyFVfQLqK7kNukHGk");
const TOKEN_MINT = new PublicKey("51JpoNC5es8mpeRhPfTPcqMFzFhxeW3UrfvTmFnbw5G1");
const SPL_TOKEN_PROGRAM_ID = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
const ASSOCIATED_TOKEN_PROGRAM_ID = new PublicKey("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");
const MULTISIG_TREASURY = new PublicKey("Eu22Js2qTu5bCr2WFY2APbvhDqAhUZpkYKmVsfeyqR2N");

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
    console.log("🚀 INICIALIZANDO PROGRAMA DE MATRIZ COM DEPÓSITO FIXO 🚀");
    console.log("===============================================================");
    console.log(`Usando arquivo de carteira: ${walletPath}`);
    console.log(`Multisig Treasury: ${MULTISIG_TREASURY.toString()}`);
    
    // Conectar à devnet
    const connection = new Connection('https://weathered-quiet-theorem.solana-devnet.quiknode.pro/198997b67cb51804baeb34ed2257274aa2b2d8c0', 'confirmed');
    console.log('Conectando à Devnet');
    
    // Carregar carteira
    let walletKeypair;
    try {
      walletKeypair = loadWalletFromFile(walletPath);
      console.log("👤 Endereço da carteira: " + walletKeypair.publicKey.toString());
    } catch (e) {
      console.error(`❌ Erro ao carregar carteira: ${e.message}`);
      return;
    }
    
    // Verificar saldo da carteira
    const balance = await connection.getBalance(walletKeypair.publicKey);
    console.log(`💰 Saldo: ${balance / 1_000_000_000} SOL`);
    
    if (balance < 1_000_000_000) {
      console.warn("⚠️ Saldo baixo! Recomendamos pelo menos 1 SOL para a inicialização.");
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
    
    // Configurar o provider com a carteira
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
    const program = new Program(idl, PROGRAM_ID, provider);
    
    // Gerar um novo keypair para o estado
    const stateKeypair = Keypair.generate();
    console.log("🔑 Novo endereço de estado: " + stateKeypair.publicKey.toString());
    
    // Inicializar o estado do programa
    console.log("\n📝 INICIALIZANDO O ESTADO DO PROGRAMA...");
    
    try {
      const tx = await program.methods
        .initialize()
        .accounts({
          state: stateKeypair.publicKey,
          owner: walletKeypair.publicKey,
          systemProgram: SystemProgram.programId,
        })
        .signers([stateKeypair])
        .rpc();
      
      console.log("✅ PROGRAMA INICIALIZADO COM SUCESSO: " + tx);
      console.log(`🔍 Link para explorador: https://explorer.solana.com/tx/${tx}?cluster=devnet`);
      
      // Verificar informações do estado
      const stateInfo = await program.account.programState.fetch(stateKeypair.publicKey);
      console.log("\n📊 INFORMAÇÕES DO ESTADO DA MATRIZ:");
      console.log("👑 Owner: " + stateInfo.owner.toString());
      console.log("🏦 Multisig Treasury: " + stateInfo.multisigTreasury.toString());
      console.log("🆔 Próximo ID de upline: " + stateInfo.nextUplineId.toString());
      console.log("🆔 Próximo ID de chain: " + stateInfo.nextChainId.toString());
      
      // Verificar PDAs necessárias para integração
      console.log("\n🔑 PDAS PARA INTEGRAÇÃO:");
      
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
      
      // Verificar se a ATA já existe
      try {
        const ataInfo = await connection.getAccountInfo(programTokenVault);
        if (ataInfo) {
          console.log("✅ ATA do Vault já existe!");
        } else {
          console.log("⚠️ ATA do Vault ainda não foi criada");
          console.log("💡 Criando ATA do vault...");
          
          // Criar ATA para o vault usando a função do Anchor
          try {
            const ataIx = utils.token.createAssociatedTokenAccountInstruction(
              walletKeypair.publicKey,      // payer
              programTokenVault,            // ata
              vaultAuthority,               // owner
              TOKEN_MINT                    // mint
            );
            
            const tx = new Transaction().add(ataIx);
            const signature = await provider.sendAndConfirm(tx);
            console.log("✅ ATA do vault criada: " + signature);
          } catch (e) {
            console.log("⚠️ Erro ao criar ATA do vault: " + e.message);
          }
        }
      } catch (e) {
        console.log("⚠️ Erro ao verificar ATA do vault: " + e.message);
      }
      
      // Gravar todas as informações importantes em um arquivo de configuração
      const configData = {
        programId: PROGRAM_ID.toString(),
        stateAddress: stateKeypair.publicKey.toString(),
        statePrivateKey: Array.from(stateKeypair.secretKey), // Guardar para uso futuro se necessário
        tokenMint: TOKEN_MINT.toString(),
        tokenMintAuthority: tokenMintAuthority.toString(),
        tokenMintAuthorityBump,
        programSolVault: programSolVault.toString(),
        programSolVaultBump,
        vaultAuthority: vaultAuthority.toString(),
        vaultAuthorityBump,
        programTokenVault: programTokenVault.toString(),
        ownerWallet: walletKeypair.publicKey.toString(),
        multisigTreasury: MULTISIG_TREASURY.toString() // Adicionado ao arquivo de configuração
      };
      
      // Criar diretório para o arquivo de configuração se não existir
      const configDir = path.dirname(configOutputPath);
      if (!fs.existsSync(configDir)) {
        fs.mkdirSync(configDir, { recursive: true });
      }
      
      fs.writeFileSync(configOutputPath, JSON.stringify(configData, null, 2));
      console.log(`\n💾 Configuração salva em ${configOutputPath}`);
      
      console.log("\n⚠️ IMPORTANTE: GUARDE ESTES ENDEREÇOS PARA USO FUTURO!");
      console.log("🔑 ENDEREÇO DO PROGRAMA: " + PROGRAM_ID.toString());
      console.log("🔑 ESTADO DO PROGRAMA: " + stateKeypair.publicKey.toString());
      console.log("🔑 OWNER DO PROGRAMA: " + walletKeypair.publicKey.toString());
      console.log("🏦 MULTISIG TREASURY: " + MULTISIG_TREASURY.toString()); // Adicionado nos logs
      console.log("🔑 PDA MINT AUTHORITY: " + tokenMintAuthority.toString());
      console.log("🔑 PDA SOL VAULT: " + programSolVault.toString());
      console.log("🔑 PDA VAULT AUTHORITY: " + vaultAuthority.toString());
      console.log("🔑 ATA DO VAULT DE TOKENS: " + programTokenVault.toString());
      
    } catch (error) {
      console.error("❌ ERRO AO INICIALIZAR O ESTADO DA MATRIZ:", error);
      
      // MELHORADO: Exibir detalhes do erro para diagnóstico
      if (error.logs) {
        console.log("\n📋 LOGS DE ERRO:");
        error.logs.forEach((log, i) => console.log(`${i}: ${log}`));
      }
    }
  } catch (error) {
    console.error("❌ ERRO GERAL DURANTE O PROCESSO:", error);
  } finally {
    process.exit(0);
  }
}

main();