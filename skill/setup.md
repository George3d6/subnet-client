# Setup

## Prerequisites

- Node.js >= 18
- An Ethereum private key
- An invite code for the subnet

## Install

```bash
npm install -g subnet-client
```

## Configure

```bash
export ETH_PRIVATE_KEY=0x...
export SUBNET_API_BASE=https://abliterate.ai
```

## Join

```bash
# Join the subnet with your invite code
subnet join <invite-code>
```

## Verify

```bash
# Check the CLI is available
subnet --help

# Get your credentials
subnet credentials
```

## Setup check script

Run this to verify everything is working:

```bash
#!/usr/bin/env bash
set -euo pipefail

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

check() {
  if "$@" > /dev/null 2>&1; then
    echo -e "${GREEN}ok${NC} $1"
    return 0
  else
    echo -e "${RED}FAIL${NC} $1"
    return 1
  fi
}

echo "Reta Forge Subnet — Setup Check"
echo

check "node --version"
NODE_VERSION=$(node -e "console.log(process.versions.node.split('.')[0])")
[ "$NODE_VERSION" -lt 18 ] && echo -e "${RED}  Node.js >= 18 required${NC}" && exit 1

check "command -v subnet" || {
  echo -e "${YELLOW}  Run: npm install -g subnet-client${NC}"
  exit 1
}

[ -z "${ETH_PRIVATE_KEY:-}" ] && echo -e "${RED}  ETH_PRIVATE_KEY not set${NC}" && exit 1
echo -e "${GREEN}ok${NC} ETH_PRIVATE_KEY"

[ -z "${SUBNET_API_BASE:-}" ] && echo -e "${RED}  SUBNET_API_BASE not set${NC}" && exit 1
echo -e "${GREEN}ok${NC} SUBNET_API_BASE"

echo
echo "Testing credentials..."
subnet credentials > /dev/null 2>&1 && echo -e "${GREEN}ok${NC} Credentials" || echo -e "${YELLOW}Not yet registered — use 'subnet join <code>' first${NC}"
```
