// Script para registrar usuário com referenciador usando Chainlink Oracle e Address Lookup Table
const { 
  Connection, 
  Keypair, 
  PublicKey, 
  TransactionMessage, 
  VersionedTransaction,
  ComputeBudgetProgram,
  TransactionInstruction,
  Transaction,
  SystemProgram
} = require('@solana/web3.js');
const { AnchorProvider, Program, BN, Wallet, utils } = require('@coral-xyz/anchor');
const fs = require('fs');
const path = require('path');

// Receber parâmetros da linha de comando (obrigatório: referenciador e ALT)
const args = process.argv.slice(2);
const walletPath = args[0] || './carteiras/carteira1.json';
const configPath = args[1] || './matriz-config.json';
const referrerAddressStr = args[2]; // Endereço do referenciador como string
const altAddress = args[3]; // Endereço da ALT como argumento obrigatório

// Função para mostrar detalhes completos da Address Lookup Table
async function getAddressLookupTable(connection, altAddress) {
  console.log("\n📋 OBTENDO ADDRESS LOOKUP TABLE:");
  
  try {
    const lookupTableInfo = await connection.getAddressLookupTable(new PublicKey(altAddress));
    if (!lookupTableInfo.value) {
      console.log("❌ ALT não encontrada!");
      return null;
    }
    
    const lookupTable = lookupTableInfo.value;
    console.log(`✅ ALT encontrada: ${altAddress}`);
    console.log(`🔢 Total de endereços: ${lookupTable.state.addresses.length}`);
    console.log(`🔑 Autoridade: ${lookupTable.state.authority ? lookupTable.state.authority.toString() : 'Nenhuma'}`);
    
    console.log("\n📋 LISTA COMPLETA DE ENDEREÇOS:");
    lookupTable.state.addresses.forEach((address, index) => {
      console.log(`  ${index}: ${address.toString()}`);
    });
    
    // Verificar propriedades do objeto para diagnóstico
    console.log("\n📋 VALIDANDO OBJETO DA LOOKUP TABLE:");
    console.log(`  Tipo: ${typeof lookupTable}`);
    console.log(`  Tem propriedade 'key': ${lookupTable.key ? "Sim" : "Não"}`);
    console.log(`  Tem propriedade 'state': ${lookupTable.state ? "Sim" : "Não"}`);
    
    return lookupTable;
  } catch (error) {
    console.error(`❌ Erro ao obter ALT: ${error}`);
    return null;
  }
}

// Função para preparar uplines para recursividade - MODIFICADA para processar TODAS as uplines
async function prepareUplinesForRecursion(connection, program, uplinePDAs, TOKEN_MINT) {
  const remainingAccounts = [];
  const triosInfo = [];

  console.log(`\n🔄 PREPARANDO ${uplinePDAs.length} UPLINES (MAX 6) PARA RECURSIVIDADE`);

  // Primeiro, coletar informações sobre as uplines
  for (let i = 0; i < Math.min(uplinePDAs.length, 6); i++) {
    const uplinePDA = uplinePDAs[i];
    console.log(`  Analisando upline ${i + 1}: ${uplinePDA.toString()}`);

    try {
      // Verificar conta do upline
      const uplineInfo = await program.account.userAccount.fetch(uplinePDA);

      if (!uplineInfo.isRegistered) {
        console.log(`  ❌ Upline não está registrado! Ignorando.`);
        continue;
      }

      // Determinar wallet do upline
      let uplineWallet;

      // Usar diretamente o campo owner_wallet
      if (uplineInfo.ownerWallet) {
        uplineWallet = uplineInfo.ownerWallet;
        console.log(`  ✅ Wallet obtida do campo owner_wallet: ${uplineWallet.toString()}`);
      }
      // Fallback para a estrutura UplineEntry se owner_wallet não existir
      else if (
        uplineInfo.upline &&
        uplineInfo.upline.upline &&
        Array.isArray(uplineInfo.upline.upline) &&
        uplineInfo.upline.upline.length > 0
      ) {
        // Procurar a entrada correspondente a esta upline específica
        let foundEntry = null;
        for (const entry of uplineInfo.upline.upline) {
          if (entry.pda && entry.pda.equals(uplinePDA)) {
            foundEntry = entry;
            console.log(`  ✅ Entrada correspondente a este PDA encontrada na estrutura UplineEntry`);
            break;
          }
        }

        if (foundEntry) {
          // Usar dados da entrada correta
          uplineWallet = foundEntry.wallet;
          console.log(`  ✅ Wallet obtida da entrada correspondente: ${uplineWallet.toString()}`);
        } else {
          // Se não encontrou a entrada correspondente, usar a primeira entrada
          console.log(`  ⚠️ Entrada específica não encontrada, usando primeira entrada da estrutura`);
          uplineWallet = uplineInfo.upline.upline[0].wallet;
          console.log(`    Wallet: ${uplineWallet.toString()}`);
        }
      } else {
        // Fallback para outros métodos se as opções anteriores falharem
        console.log(`  ⚠️ Estrutura UplineEntry ausente ou incompleta (possível usuário base)`);
        continue;
      }

      // Derivar a ATA para o token
      const uplineTokenAccount = utils.token.associatedAddress({
        mint: TOKEN_MINT,
        owner: uplineWallet,
      });

      console.log(`  💰 ATA derivada para a wallet: ${uplineTokenAccount.toString()}`);

      // Verificar se a ATA existe e criar se necessário
      const ataInfo = await connection.getAccountInfo(uplineTokenAccount);
      if (!ataInfo) {
        console.log(`  ⚠️ ATA não existe, será derivada on-chain pelo contrato`);
      } else {
        console.log(`  ✅ ATA já existe`);
      }

      // Armazenar informações para ordenação - TRIO: PDA, wallet, ATA
      triosInfo.push({
        pda: uplinePDA,
        wallet: uplineWallet,
        ata: uplineTokenAccount,
        depth: parseInt(uplineInfo.upline.depth.toString()),
      });
    } catch (e) {
      console.log(`  ❌ Erro ao analisar upline: ${e.message}`);
    }
  }

  // IMPORTANTE: Ordenar os trios por profundidade DECRESCENTE (maior para menor)
  triosInfo.sort((a, b) => b.depth - a.depth);
  
  // MODIFICAÇÃO: Usar todas as uplines coletadas sem limitação
  console.log(`\n✅ PROCESSANDO TODAS AS ${triosInfo.length} UPLINES NA RECURSIVIDADE`);

  console.log(`\n📊 ORDEM DE PROCESSAMENTO DAS UPLINES (Maior profundidade → Menor):`);
  for (let i = 0; i < triosInfo.length; i++) {
    console.log(`  ${i + 1}. PDA: ${triosInfo[i].pda.toString()} (Profundidade: ${triosInfo[i].depth})`);
    console.log(`    Wallet: ${triosInfo[i].wallet.toString()}`);
    console.log(`    ATA (derivada): ${triosInfo[i].ata.toString()}`);
  }

  // Construir o array remainingAccounts com TODOS os trios
  for (let i = 0; i < triosInfo.length; i++) {
    const trio = triosInfo[i];

    // 1. Adicionar a PDA da conta
    remainingAccounts.push({
      pubkey: trio.pda,
      isWritable: true,
      isSigner: false,
    });

    // 2. Adicionar a wallet
    remainingAccounts.push({
      pubkey: trio.wallet,
      isWritable: true,
      isSigner: false,
    });

    // 3. Adicionar a ATA
    remainingAccounts.push({
      pubkey: trio.ata,
      isWritable: true,
      isSigner: false,
    });
  }

  // Verificação extra para garantir que só temos trios
  if (remainingAccounts.length % 3 !== 0) {
    console.error("⚠️ ALERTA: Número de contas não é múltiplo de 3. Isso indica um problema!");
  } else {
    console.log(`  ✅ Total de uplines processados: ${remainingAccounts.length / 3}`);
    console.log(`  ✅ Total de contas adicionadas: ${remainingAccounts.length}`);
    console.log(`  ✅ Confirmado: APENAS TRIOS (PDA, wallet, ATA) sendo passados!`);
  }

  return remainingAccounts;
}

async function main() {
  try {
    console.log("🚀 REGISTRANDO USUÁRIO COM REFERENCIADOR, CHAINLINK ORACLE E ALT 🚀");
    console.log("================================================================");

    // Verificar argumentos obrigatórios
    if (!referrerAddressStr) {
      console.error("❌ ERRO: Endereço do referenciador não fornecido!");
      console.error("Por favor, especifique o endereço do referenciador como terceiro argumento.");
      console.error("Exemplo: node referv4.js /caminho/para/carteira.json ./matriz-config.json EnderecoDoReferenciador EnderecoALT");
      return;
    }
    
    if (!altAddress) {
      console.error("❌ ERRO: Endereço da ALT não fornecido!");
      console.error("Por favor, especifique o endereço da ALT como quarto argumento.");
      console.error("Exemplo: node referv4.js /caminho/para/carteira.json ./matriz-config.json EnderecoDoReferenciador EnderecoALT");
      return;
    }
    
    // Converter referrerAddressStr para PublicKey
    const referrerAddress = new PublicKey(referrerAddressStr);
    
    // Carregar carteira
    console.log(`Carregando carteira de ${walletPath}...`);
    let walletKeypair;
    try {
      const secretKeyString = fs.readFileSync(walletPath, { encoding: 'utf8' });
      walletKeypair = Keypair.fromSecretKey(
        Uint8Array.from(JSON.parse(secretKeyString))
      );
    } catch (e) {
      console.error(`❌ Erro ao carregar carteira: ${e.message}`);
      return;
    }
    
    // Carregar IDL
    console.log("Carregando IDL...");
    const idlPath = path.resolve('./target/idl/referral_system.json');
    const idl = require(idlPath);
    
    // Carregar configuração (se disponível)
    let config = {};
    if (fs.existsSync(configPath)) {
      console.log(`Carregando configuração de ${configPath}...`);
      config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
      console.log("Configuração carregada com sucesso");
    } else {
      console.log(`⚠️ Arquivo de configuração não encontrado em ${configPath}`);
      console.log("⚠️ Usando valores padrão para endereços...");
    }
    
    // Configuração da conexão (devnet para o programa)
    const connection = new Connection('https://weathered-quiet-theorem.solana-devnet.quiknode.pro/198997b67cb51804baeb34ed2257274aa2b2d8c0', {
      commitment: 'confirmed',
      confirmTransactionInitialTimeout: 60000 // 60 segundos de timeout
    });
    console.log('Conectando à Devnet');
    
     // Configurar endereços importantes
     const MATRIX_PROGRAM_ID = new PublicKey(config.programId || "jFUpBH7wTd9G1EfFADhJCZ89CSujPoh15bdWL5NutT9");
     const TOKEN_MINT = new PublicKey(config.tokenMint || "H4T9Y1wGsexYKYshYbqHG3fKhu16nkJhyYQArp1Q1Adj");
     const STATE_ADDRESS = new PublicKey(config.stateAddress || "5vpLg8dHiGXxRR7LMED5x88zA6PCQDiqdSeMUzBsEEY1");
     
    // Pool e vault addresses
    const POOL_ADDRESS = new PublicKey("H7RMjuMb8GAv3NxvvsqLVHf4kyroagoeqmDiiM8198j9");
    
    // Vault A addresses (DONUT)
    const A_VAULT_LP = new PublicKey("3NNXTmZPY2wwotbz8eRU5F9PpnDYG9vVMv5GYArSWA7F");
    const A_VAULT_LP_MINT = new PublicKey("6toHu9J2rUigsStD4GNyCbMiybbqFhYjWnZtiHkRYrou");
    const A_TOKEN_VAULT = new PublicKey("FnEXDYHyyN7ZBCsjZDx7psoCsVRTJ9orVC7ijtQuVhyv");
    
    // Vault B addresses (SOL)
    const B_VAULT = new PublicKey("FERjPVNEa7Udq8CEv68h6tPL46Tq7ieE49HrE2wea3XT");
    const B_TOKEN_VAULT = new PublicKey("HZeLxbZ9uHtSpwZC3LBr4Nubd14iHwz7bRSghRZf5VCG");
    const B_VAULT_LP_MINT = new PublicKey("BvoAjwEDhpLzs3jtu4H72j96ShKT5rvZE9RP1vgpfSM");
    const B_VAULT_LP = new PublicKey("C3yfTo4r7AhpgDpmmjVG34WaUKV749748TXEgRCsBYK7");
    const VAULT_PROGRAM = new PublicKey("24Uqj9JCLxUeoC3hGfh5W3s9FM9uCHDS2SG3LYwBpyTi");
    
    // Chainlink addresses (Devnet)
    const CHAINLINK_PROGRAM = new PublicKey("HEvSKofvBgfaexv23kMabbYqxasxU3mQ4ibBMEmJWHny");
    const SOL_USD_FEED = new PublicKey("99B2bTijsU6f1GCT73HmdR7HCFFjGMBcPZY6jZ96ynrR");

    // Programas do sistema
    const WSOL_MINT = new PublicKey("So11111111111111111111111111111111111111112");
    const SPL_TOKEN_PROGRAM_ID = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
    const SYSTEM_PROGRAM_ID = new PublicKey("11111111111111111111111111111111");
    const ASSOCIATED_TOKEN_PROGRAM_ID = new PublicKey("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");
    const SYSVAR_RENT_PUBKEY = new PublicKey("SysvarRent111111111111111111111111111111111");
    
    // Criar wallet usando a classe Wallet do Anchor
    const anchorWallet = new Wallet(walletKeypair);
    
    // Configurar o provider com o objeto Wallet do Anchor
    const provider = new AnchorProvider(
      connection,
      anchorWallet,
      { 
        commitment: 'confirmed',
        skipPreflight: true,      // Adicionar esta opção
        preflightCommitment: 'processed', // Adicionar esta opção
        disableAutomaticAccountCreation: true // Se esta opção existir no Anchor (verificar documentação)
      }
    );
    
    // Inicializar o programa
    const program = new Program(idl, MATRIX_PROGRAM_ID, provider);
    
    // Verificar saldo da carteira
    console.log("\n👤 CARTEIRA DO USUÁRIO: " + walletKeypair.publicKey.toString());
    console.log("👥 REFERENCIADOR: " + referrerAddress.toString());
    const balance = await connection.getBalance(walletKeypair.publicKey);
    console.log("💰 SALDO ATUAL: " + balance / 1e9 + " SOL");
    
    // Valor fixo do depósito (0.08 SOL)
    const FIXED_DEPOSIT_AMOUNT = 80_000_000;
    
    if (balance < FIXED_DEPOSIT_AMOUNT + 30000000) {
      console.error("❌ ERRO: Saldo insuficiente! Você precisa de pelo menos " + 
                   (FIXED_DEPOSIT_AMOUNT + 30000000) / 1e9 + " SOL");
      return;
    }
    
    // Verificar referenciador
    console.log("\n🔍 VERIFICANDO REFERENCIADOR...");
    const [referrerAccount] = PublicKey.findProgramAddressSync(
      [Buffer.from("user_account"), referrerAddress.toBuffer()],
      MATRIX_PROGRAM_ID
    );
    console.log("📄 PDA DO REFERENCIADOR: " + referrerAccount.toString());
    
    let referrerInfo;
    try {
      referrerInfo = await program.account.userAccount.fetch(referrerAccount);
      if (!referrerInfo.isRegistered) {
        console.error("❌ ERRO: O referenciador não está registrado!");
        return;
      }
      
      console.log("✅ Referenciador verificado");
      console.log("🔢 Profundidade: " + referrerInfo.upline.depth.toString());
      console.log("📊 Slots preenchidos: " + referrerInfo.chain.filledSlots + "/3");
      
      // Verificar campo owner_wallet
      if (referrerInfo.ownerWallet) {
        console.log("✅ Referenciador tem campo owner_wallet: " + referrerInfo.ownerWallet.toString());
      }
      
      // Avisar o slot que será preenchido
      const nextSlotIndex = referrerInfo.chain.filledSlots;
      if (nextSlotIndex >= 3) {
        console.log("⚠️ ATENÇÃO: A matriz do referenciador já está cheia!");
        return;
      }
      
      console.log("🎯 VOCÊ PREENCHERÁ O SLOT " + (nextSlotIndex + 1) + " DA MATRIZ");
    } catch (e) {
      console.error("❌ Erro ao verificar referenciador:", e);
      return;
    }
    
    // Verificar conta do usuário
    console.log("\n🔍 VERIFICANDO SUA CONTA...");
    const [userAccount] = PublicKey.findProgramAddressSync(
      [Buffer.from("user_account"), walletKeypair.publicKey.toBuffer()],
      MATRIX_PROGRAM_ID
    );
    console.log("📄 CONTA DO USUÁRIO (PDA): " + userAccount.toString());
    
    try {
      const userInfo = await program.account.userAccount.fetch(userAccount);
      if (userInfo.isRegistered) {
        console.log("⚠️ Você já está registrado no sistema!");
        return;
      }
    } catch (e) {
      console.log("✅ USUÁRIO AINDA NÃO REGISTRADO, PROSSEGUINDO COM O REGISTRO...");
    }
    
    // Obter endereços de PDAs e ATAs necessárias
    console.log("\n🔧 OBTENDO PDAs NECESSÁRIAS...");
    
    // PDA para autoridade de mintagem
    const [tokenMintAuthority, tokenMintAuthorityBump] = PublicKey.findProgramAddressSync(
      [Buffer.from("token_mint_authority")],
      MATRIX_PROGRAM_ID
    );
    console.log("🔑 TOKEN_MINT_AUTHORITY: " + tokenMintAuthority.toString());
    
    // PDA para vault authority
    const [vaultAuthority, vaultAuthorityBump] = PublicKey.findProgramAddressSync(
      [Buffer.from("token_vault_authority")],
      MATRIX_PROGRAM_ID
    );
    console.log("🔑 VAULT_AUTHORITY: " + vaultAuthority.toString());
    
    // PDA para program_sol_vault
    const [programSolVault, programSolVaultBump] = PublicKey.findProgramAddressSync(
      [Buffer.from("program_sol_vault")],
      MATRIX_PROGRAM_ID
    );
    console.log("🔑 PROGRAM_SOL_VAULT: " + programSolVault.toString());
    
    // Derivar ATA para o vault de tokens
    const programTokenVault = utils.token.associatedAddress({
      mint: TOKEN_MINT,
      owner: vaultAuthority,
    });
    console.log("🔑 PROGRAM_TOKEN_VAULT (ATA): " + programTokenVault.toString());
    
    // Derivar ATA para o referenciador
    let referrerTokenAccount;
    if (referrerInfo.ownerWallet) {
      // Usar o campo owner_wallet para derivar a ATA
      referrerTokenAccount = utils.token.associatedAddress({
        mint: TOKEN_MINT,
        owner: referrerInfo.ownerWallet,
      });
    } else {
      // Fallback para o endereço direto do referenciador
      referrerTokenAccount = utils.token.associatedAddress({
        mint: TOKEN_MINT,
        owner: referrerAddress,
      });
    }
    console.log("🔑 REFERRER_TOKEN_ACCOUNT (ATA): " + referrerTokenAccount.toString());
    
    // Derivar ATA para o novo usuário (para WSOL)
    const userWsolAccount = utils.token.associatedAddress({
      mint: WSOL_MINT,
      owner: walletKeypair.publicKey,
    });
    console.log("🔑 USER_WSOL_ACCOUNT (ATA): " + userWsolAccount.toString());

    // IMPORTANTE: Verificar e criar ATAs necessárias antes de prosseguir
    console.log("\n🔧 VERIFICANDO E CRIANDO ATAS NECESSÁRIAS...");

    // Verificar ATAs
    try {
        // Verificar ATA do vault
        const vaultTokenAccountInfo = await connection.getAccountInfo(programTokenVault);
        if (!vaultTokenAccountInfo) {
          console.log("  ⚠️ ATA do vault não existe, será criada on-chain pelo programa");
        } else {
          console.log("  ✅ ATA do vault já existe");
        }
        
        // Verificar ATA do referenciador
        const refTokenAccountInfo = await connection.getAccountInfo(referrerTokenAccount);
        if (!refTokenAccountInfo) {
          console.log("  ⚠️ ATA do referenciador não existe, criando explicitamente...");
          
          // Criar ATA para o referenciador
          const createRefATAIx = new TransactionInstruction({
            keys: [
              { pubkey: walletKeypair.publicKey, isSigner: true, isWritable: true },
              { pubkey: referrerTokenAccount, isSigner: false, isWritable: true },
              { pubkey: referrerAddress, isSigner: false, isWritable: false },
              { pubkey: TOKEN_MINT, isSigner: false, isWritable: false },
              { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
              { pubkey: SPL_TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
              { pubkey: SYSVAR_RENT_PUBKEY, isSigner: false, isWritable: false }
            ],
            programId: ASSOCIATED_TOKEN_PROGRAM_ID,
            data: Buffer.from([])
          });
          
          const tx = new Transaction().add(createRefATAIx);
          tx.feePayer = walletKeypair.publicKey;
          const { blockhash } = await connection.getLatestBlockhash();
          tx.recentBlockhash = blockhash;
          
          const signedTx = await provider.wallet.signTransaction(tx);
          const txid = await connection.sendRawTransaction(signedTx.serialize());
          
          // Aguardar a confirmação da transação
          await connection.confirmTransaction(txid);
          console.log("  ✅ ATA do referenciador criada: " + txid);
        } else {
          console.log("  ✅ ATA do referenciador já existe");
        }
    } catch (e) {
        console.error("  ❌ ERRO ao verificar ATAs:", e);
    }
    
    // 4. Preparar uplines para recursividade (se necessário)
    let uplineAccounts = [];
    const isSlot3 = referrerInfo.chain.filledSlots === 2;
    
    if (isSlot3 && referrerInfo.upline && referrerInfo.upline.upline) {
      console.log("\n🔄 Preparando uplines para recursividade (slot 3)");
      
      try {
        const uplines = [];
        // Extrair os PDAs da estrutura UplineEntry
        for (const entry of referrerInfo.upline.upline) {
          uplines.push(entry.pda);
        }
        
        if (uplines && uplines.length > 0) {
          console.log(`  Encontradas ${uplines.length} uplines disponíveis`);
          // Processar uplines usando a função adaptada
          uplineAccounts = await prepareUplinesForRecursion(connection, program, uplines, TOKEN_MINT);
        } else {
          console.log("  Referenciador não tem uplines anteriores");
        }
      } catch (e) {
        console.log(`❌ Erro ao preparar recursividade: ${e.message}`);
      }
    }
    
    // 5. Carregar a Address Lookup Table (MÉTODO CORRIGIDO)
    console.log("\n🔍 CARREGANDO ADDRESS LOOKUP TABLE...");
    
    // Obter a ALT diretamente da API usando o método correto
    const lookupTableAccount = await getAddressLookupTable(connection, altAddress);
    
    if (!lookupTableAccount) {
      console.error("❌ ERRO: Address Lookup Table não encontrada ou inválida!");
      return;
    }
    
    // 6. EXECUTAR REGISTRO COM VERSIONED TRANSACTION
    console.log("\n📤 PREPARANDO TRANSAÇÃO VERSIONADA COM ALT...");
    
    try {
      // Obter o blockhash recente para a transação
      const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash();
      
      // Instrução para aumentar o limite de compute units
      const modifyComputeUnits = ComputeBudgetProgram.setComputeUnitLimit({
        units: 1_400_000 // Aumentar para 1.4 milhão para garantir processamento de todas as uplines
      });
      
      // Adicionar também uma instrução de prioridade
      const setPriority = ComputeBudgetProgram.setComputeUnitPrice({
        microLamports: 5000 // Aumentar prioridade da transação
      });
      
      // Configurar contas do Vault A e Chainlink para remaining_accounts
      const vaultAAccounts = [
        { pubkey: A_VAULT_LP, isWritable: true, isSigner: false },
        { pubkey: A_VAULT_LP_MINT, isWritable: true, isSigner: false },
        { pubkey: A_TOKEN_VAULT, isWritable: true, isSigner: false },
      ];
      
      const chainlinkAccounts = [
        { pubkey: SOL_USD_FEED, isWritable: false, isSigner: false },      // Feed na posição 3
        { pubkey: CHAINLINK_PROGRAM, isWritable: false, isSigner: false }, // Programa na posição 4
      ];
      
      // Combinar contas do Vault A e Chainlink com uplines para remaining_accounts completo
      const allRemainingAccounts = [...vaultAAccounts, ...chainlinkAccounts, ...uplineAccounts];
      
      // Verificar se os índices 3 e 4 têm os endereços corretos
      console.log("\n🔍 VERIFICANDO ORDEM DE REMAINING_ACCOUNTS:");
      console.log(`  Índice 3 (Feed): ${allRemainingAccounts[3].pubkey.toString()}`);
      console.log(`  Índice 4 (Programa): ${allRemainingAccounts[4].pubkey.toString()}`);
      console.log(`  Endereço esperado Feed: ${SOL_USD_FEED.toString()}`);
      console.log(`  Endereço esperado Programa: ${CHAINLINK_PROGRAM.toString()}`);
      
      if (!allRemainingAccounts[3].pubkey.equals(SOL_USD_FEED) || 
          !allRemainingAccounts[4].pubkey.equals(CHAINLINK_PROGRAM)) {
        console.error("❌ ERRO: A ordem das contas Chainlink está incorreta!");
        return;
      }
      
      // Gerar a instrução com Anchor apenas para obter o formato correto
      console.log("\n🔧 Gerando instrução com Anchor...");
      const anchorIx = await program.methods
        .registerWithSolDeposit(new BN(FIXED_DEPOSIT_AMOUNT))
        .accounts({
          state: STATE_ADDRESS,
          userWallet: walletKeypair.publicKey,
          referrer: referrerAccount,
          referrerWallet: referrerAddress,
          user: userAccount,
          userWsolAccount: userWsolAccount,
          wsolMint: WSOL_MINT,
          pool: POOL_ADDRESS,
          bVault: B_VAULT,
          bTokenVault: B_TOKEN_VAULT,
          bVaultLpMint: B_VAULT_LP_MINT,
          bVaultLp: B_VAULT_LP,
          vaultProgram: VAULT_PROGRAM,
          programSolVault: programSolVault,
          tokenMint: TOKEN_MINT,
          programTokenVault: programTokenVault,
          referrerTokenAccount: referrerTokenAccount,
          tokenMintAuthority: tokenMintAuthority,
          vaultAuthority: vaultAuthority,
          tokenProgram: SPL_TOKEN_PROGRAM_ID,
          systemProgram: SYSTEM_PROGRAM_ID,
          associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
          rent: SYSVAR_RENT_PUBKEY,
        })
        .remainingAccounts(allRemainingAccounts)
        .instruction();

      // Extrair os dados da instrução para usar em nossa instrução manual
      const ixData = anchorIx.data;
      console.log(`🔍 Instrução gerada com discriminador: ${Buffer.from(ixData.slice(0, 8)).toString('hex')}`);

      // Criar uma nova instrução manual com os mesmos dados
      const manualRegisterInstruction = new TransactionInstruction({
        keys: anchorIx.keys,
        programId: MATRIX_PROGRAM_ID,
        data: ixData
      });

      // Criar array de instruções
      console.log("🔧 Criando instruções para transação...");
      const instructions = [
        modifyComputeUnits,
        setPriority,
        manualRegisterInstruction
      ];

      // Criar uma mensagem v0 com a lookup table
      console.log("\n🔧 Criando mensagem V0 com lookup table...");
      const messageV0 = new TransactionMessage({
        payerKey: walletKeypair.publicKey,
        recentBlockhash: blockhash,
        instructions
      }).compileToV0Message([lookupTableAccount]);

      // Criar uma transação versionada
      const transaction = new VersionedTransaction(messageV0);

      // Assinar a transação com o pagador
      transaction.sign([walletKeypair]);

      console.log("✅ Transação versionada manual criada e assinada");
      console.log(`📊 Usando ALT com ${lookupTableAccount.state.addresses.length} endereços`);
      console.log(`⚙️ Versão da transação: V0 (Versionada manual)`);
      console.log(`🔄 Processando ${uplineAccounts.length / 3} uplines na recursividade`);

      // Enviar a transação versionada
      console.log("\n📤 ENVIANDO TRANSAÇÃO VERSIONADA MANUAL...");

      // Enviar a transação com retry e sem preflight
      const txid = await connection.sendTransaction(transaction, {
        maxRetries: 5,
        skipPreflight: true
      });
      
      console.log("✅ Transação enviada: " + txid);
      console.log(`🔍 Link para explorador: https://explorer.solana.com/tx/${txid}?cluster=devnet`);
      
      console.log("\n⏳ Aguardando confirmação...");
      const confirmation = await connection.confirmTransaction(
        {
          signature: txid,
          blockhash: blockhash,
          lastValidBlockHeight: lastValidBlockHeight,
        },
        'confirmed'
      );
      
      if (confirmation.value.err) {
        throw new Error(`Erro na confirmação da transação: ${JSON.stringify(confirmation.value.err)}`);
      }
      
      console.log("✅ Transação confirmada!");
      console.log("✅ Versão da transação: V0 (Versionada)");
      
      // 7. Verificar resultados
      console.log("\n🔍 VERIFICANDO RESULTADOS...");
      
      try {
        // Verificar estado da conta do usuário
        const userInfo = await program.account.userAccount.fetch(userAccount);
        console.log("\n📋 CONFIRMAÇÃO DO REGISTRO:");
        console.log("✅ Usuário registrado: " + userInfo.isRegistered);
        console.log("🧑‍🤝‍🧑 Referenciador: " + userInfo.referrer.toString());
        console.log("🔢 Profundidade: " + userInfo.upline.depth.toString());
        console.log("📊 Slots preenchidos: " + userInfo.chain.filledSlots + "/3");
        
        // Verificar campo owner_wallet
        if (userInfo.ownerWallet) {
          console.log("\n📋 CAMPOS DA CONTA:");
          console.log("👤 Owner Wallet: " + userInfo.ownerWallet.toString());
          
          if (userInfo.ownerWallet.equals(walletKeypair.publicKey)) {
            console.log("✅ O campo owner_wallet foi corretamente preenchido");
          } else {
            console.log("❌ ALERTA: Owner Wallet não corresponde à carteira do usuário!");
          }
        }
        
        // Exibir informações da estrutura UplineEntry
        if (userInfo.upline.upline && userInfo.upline.upline.length > 0) {
          console.log("\n📋 INFORMAÇÕES DAS UPLINES:");
          userInfo.upline.upline.forEach((entry, index) => {
            console.log(`  Upline #${index+1}:`);
            console.log(`    PDA: ${entry.pda.toString()}`);
            console.log(`    Wallet: ${entry.wallet.toString()}`);
          });
        }
        
        // Verificar estado do referenciador após o registro
        const newReferrerInfo = await program.account.userAccount.fetch(referrerAccount);
        console.log("\n📋 ESTADO DO REFERENCIADOR APÓS REGISTRO:");
        console.log("📊 Slots preenchidos: " + newReferrerInfo.chain.filledSlots + "/3");
        
        // Verificar tokens reservados (se estamos no slot 2)
        if (
          referrerInfo.chain.filledSlots === 1 &&
          newReferrerInfo.reservedTokens > 0
        ) {
          console.log(`💰 Tokens reservados: ${newReferrerInfo.reservedTokens / 1e9} tokens`);
        }
        
        // Se estava no slot 3, verificar processamento da recursividade
        if (isSlot3 && uplineAccounts.length > 0) {
          console.log("\n🔄 VERIFICANDO RESULTADO DA RECURSIVIDADE:");
          
          let uplineReverseCount = 0;
          for (let i = 0; i < uplineAccounts.length; i += 3) {
            if (i >= uplineAccounts.length) break;
            
            try {
              const uplineAccount = uplineAccounts[i].pubkey;
              
              console.log(`\n  Verificando upline: ${uplineAccount.toString()}`);
              
              const uplineInfo = await program.account.userAccount.fetch(uplineAccount);
              console.log(`  Slots preenchidos: ${uplineInfo.chain.filledSlots}/3`);
              
              // Verificar se o referenciador foi adicionado à matriz do upline
              for (let j = 0; j < uplineInfo.chain.filledSlots; j++) {
                if (
                  uplineInfo.chain.slots[j] &&
                  uplineInfo.chain.slots[j].equals(referrerAccount)
                ) {
                  console.log(`  ✅ REFERENCIADOR ADICIONADO NO SLOT ${j + 1}!`);
                  uplineReverseCount++;
                  break;
                }
              }
              
              // Verificar valores reservados
              if (uplineInfo.reservedSol > 0) {
                console.log(`  💰 SOL Reservado: ${uplineInfo.reservedSol / 1e9} SOL`);
              }
              
              if (uplineInfo.reservedTokens > 0) {
                console.log(`  🪙 Tokens Reservados: ${uplineInfo.reservedTokens / 1e9} tokens`);
              }
            } catch (e) {
              console.log(`  Erro ao verificar upline: ${e.message}`);
            }
          }
          
          console.log(`\n  ✅ Recursividade processou ${uplineReverseCount}/${uplineAccounts.length / 3} uplines`);
        }
        
        // Obter e mostrar o novo saldo
        const newBalance = await connection.getBalance(walletKeypair.publicKey);
        console.log("\n💼 Seu novo saldo: " + newBalance / 1e9 + " SOL");
        console.log("💰 SOL gasto: " + (balance - newBalance) / 1e9 + " SOL");
        
        console.log("\n🎉 REGISTRO COM REFERENCIADOR E ALT CONCLUÍDO COM SUCESSO! 🎉");
        console.log("===========================================================");
        console.log("\n⚠️ IMPORTANTE: GUARDE ESTES ENDEREÇOS PARA USO FUTURO:");
        console.log("🔑 SEU ENDEREÇO: " + walletKeypair.publicKey.toString());
        console.log("🔑 SUA CONTA PDA: " + userAccount.toString());
        console.log("🔑 ADDRESS LOOKUP TABLE: " + altAddress.toString());
      } catch (e) {
        console.error("❌ ERRO AO VERIFICAR RESULTADOS:", e);
      }
    } catch (error) {
      console.error("❌ ERRO AO REGISTRAR USUÁRIO:", error);
      
      if (error.logs) {
        console.log("\n📋 LOGS DE ERRO DETALHADOS:");
        const relevantLogs = error.logs.filter(log => 
          log.includes("Program log:") || 
          log.includes("Error") || 
          log.includes("error")
        );
        
        if (relevantLogs.length > 0) {
          relevantLogs.forEach((log, i) => console.log(`  ${i}: ${log}`));
        } else {
          error.logs.forEach((log, i) => console.log(`  ${i}: ${log}`));
        }
      }
    }
  } catch (error) {
    console.error("❌ ERRO GERAL DURANTE O PROCESSO:", error);
    
    if (error.logs) {
      console.log("\n📋 LOGS DE ERRO DETALHADOS:");
      error.logs.forEach((log, i) => console.log(`${i}: ${log}`));
    }
  }
}

main();