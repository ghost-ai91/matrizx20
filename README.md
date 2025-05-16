# DONUT Referral Matrix System

A decentralized referral matrix system on the Solana blockchain that rewards participants for bringing new users to the network.

## Overview

The DONUT Referral Matrix System is a protocol designed to incentivize user acquisition through a multi-level referral structure. The system creates a 3-slot matrix for each user, where each slot represents a different action when filled:

- **Slot 1**: Deposit SOL to liquidity pools
- **Slot 2**: Reserve SOL and mint DONUT tokens
- **Slot 3**: Pay reserved SOL and tokens to referrers

## Key Features

- **Verifiable Smart Contract**: The code is publicly available and verified on-chain
- **Chainlink Integration**: Uses Chainlink oracles for reliable SOL/USD price feeds
- **Meteora Pool Integration**: Interacts with liquidity pools for token exchanges
- **Secure Address Verification**: Implements strict address validation for security
- **Automated Referral Processing**: Handles the full referral chain automatically

## Technical Details

- **Chain Structure**: Each user has a matrix with 3 slots
- **Upline Management**: Users can have multiple upline referrers with defined depth
- **Token Economics**: SOL deposits are converted to DONUT tokens based on pool rates
- **Secure Operations**: All functions implement strict validation and error handling

## Security

See [SECURITY.md](./SECURITY.md) for our security policy and reporting vulnerabilities.

## Contact

For questions or support:
- Email: ghostninjax01@gmail.com
- Discord: ghostninjax01
- WhatsApp: [Contact via email for WhatsApp]

## License

This project is licensed under the MIT License - see the LICENSE file for details.
