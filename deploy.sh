#!/usr/bin/env bash
set -euo pipefail

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

SCRATCHY_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRATCHY_DIR"

# Flags
PROMOTE_PREVIEW=false
SKIP_TESTS=false
TAG=""

# Parse args
while [[ $# -gt 0 ]]; do
  case $1 in
    --promote)  PROMOTE_PREVIEW=true; shift ;;
    --skip-tests) SKIP_TESTS=true; shift ;;
    --tag)      TAG="$2"; shift 2 ;;
    -h|--help)
      echo "Usage: deploy.sh [--promote] [--skip-tests] [--tag vX.Y.Z]"
      echo "  --promote    Copy web-preview/ → web/ before deploying"
      echo "  --skip-tests Skip test suite"
      echo "  --tag TAG    Create a git tag"
      exit 0 ;;
    *) echo -e "${RED}Unknown option: $1${NC}"; exit 1 ;;
  esac
done

echo ""
echo -e "${BLUE}═══════════════════════════════${NC}"
echo -e "${BLUE}  🐱 Scratchy Deploy${NC}"
echo -e "${BLUE}═══════════════════════════════${NC}"
echo ""

# ─── 1. Pre-flight checks ───────────────────────────────────────────

echo -e "${BLUE}🛫 Pre-flight checks...${NC}"

# Verify we're in the scratchy directory
if [ ! -f "$SCRATCHY_DIR/serve.js" ]; then
  echo -e "${RED}❌ Not in the scratchy directory (serve.js not found)${NC}"
  exit 1
fi
echo -e "  ${GREEN}✓${NC} In scratchy directory: $SCRATCHY_DIR"

# Check git status — warn if uncommitted changes (don't block)
if command -v git &>/dev/null && [ -d ".git" ]; then
  if [ -n "$(git status --porcelain 2>/dev/null)" ]; then
    echo -e "  ${YELLOW}⚠ Uncommitted changes detected${NC}"
  else
    echo -e "  ${GREEN}✓${NC} Working tree clean"
  fi
else
  echo -e "  ${YELLOW}⚠ Not a git repo or git not available${NC}"
fi

# Verify node is available
if ! command -v node &>/dev/null; then
  echo -e "${RED}❌ node not found in PATH${NC}"
  exit 1
fi
echo -e "  ${GREEN}✓${NC} Node $(node --version)"

echo ""

# ─── 2. Syntax check all JS files ───────────────────────────────────

echo -e "${BLUE}🔍 Checking JavaScript syntax...${NC}"
ERRORS=0

for f in serve.js lib/*.js genui-engine/templates/*.js; do
  [ -f "$f" ] || continue
  if ! node -c "$f" 2>/dev/null; then
    echo -e "  ${RED}❌ $f${NC}"
    ERRORS=$((ERRORS + 1))
  fi
done

# Also check web JS files
if compgen -G "web/js/*.js" >/dev/null 2>&1; then
  for f in web/js/*.js; do
    [ -f "$f" ] || continue
    if ! node -c "$f" 2>/dev/null; then
      echo -e "  ${RED}❌ $f${NC}"
      ERRORS=$((ERRORS + 1))
    fi
  done
fi

if [ $ERRORS -gt 0 ]; then
  echo -e "${RED}❌ $ERRORS syntax error(s) found. Fix before deploying.${NC}"
  exit 1
fi
echo -e "${GREEN}✅ All JS files pass syntax check${NC}"
echo ""

# ─── 3. Run tests ───────────────────────────────────────────────────

if [ "$SKIP_TESTS" = false ]; then
  echo -e "${BLUE}🧪 Running tests...${NC}"

  if [ -f "lib/toon-encoder.test.js" ]; then
    node lib/toon-encoder.test.js || { echo -e "${RED}❌ Encoder tests failed${NC}"; exit 1; }
  else
    echo -e "  ${YELLOW}⚠ lib/toon-encoder.test.js not found — skipping${NC}"
  fi

  if [ -f "test/toon-roundtrip.js" ]; then
    node test/toon-roundtrip.js || { echo -e "${RED}❌ Round-trip tests failed${NC}"; exit 1; }
  else
    echo -e "  ${YELLOW}⚠ test/toon-roundtrip.js not found — skipping${NC}"
  fi

  echo -e "${GREEN}✅ All tests pass${NC}"
  echo ""
else
  echo -e "${YELLOW}⏭  Skipping tests (--skip-tests)${NC}"
  echo ""
fi

# ─── 4. Promote preview ─────────────────────────────────────────────

if [ "$PROMOTE_PREVIEW" = true ]; then
  if [ -d "web-preview" ] && [ ! -L "web-preview" ]; then
    echo -e "${BLUE}📦 Promoting web-preview/ → web/...${NC}"

    # Backup current web/
    if [ -d "web" ]; then
      BACKUP="web-backup-$(date +%Y%m%d-%H%M%S)"
      cp -r web "$BACKUP"
      echo -e "  Backed up web/ → ${BACKUP}/"
    fi

    # Copy preview over production
    rsync -a --delete web-preview/ web/
    echo -e "${GREEN}✅ Preview promoted to production${NC}"
  else
    echo -e "${YELLOW}⚠️  web-preview/ is a symlink or doesn't exist — skipping promote${NC}"
  fi
  echo ""
fi

# ─── 5. Git commit and tag ──────────────────────────────────────────

if command -v git &>/dev/null && [ -d ".git" ]; then
  if [ -n "$(git status --porcelain)" ]; then
    echo -e "${BLUE}📝 Committing changes...${NC}"
    git add -A
    git commit -m "deploy: $(date +%Y-%m-%d_%H:%M)"
  fi

  if [ -n "$TAG" ]; then
    echo -e "${BLUE}🏷️  Tagging ${TAG}...${NC}"
    git tag "$TAG"
  fi
  echo ""
fi

# ─── 6. Restart Scratchy ────────────────────────────────────────────

echo -e "${BLUE}🔄 Restarting Scratchy...${NC}"
systemctl --user restart scratchy
sleep 2

# ─── 7. Health check ────────────────────────────────────────────────

echo -e "${BLUE}🏥 Health check...${NC}"

# Try /api/version first, fall back to /
HTTP_CODE=$(curl -s -o /dev/null -w "%{http_code}" http://localhost:3001/api/version 2>/dev/null || echo "000")

if [ "$HTTP_CODE" = "200" ]; then
  VERSION=$(curl -s http://localhost:3001/api/version 2>/dev/null | node -e "process.stdin.on('data',d=>{try{console.log(JSON.parse(d).hash)}catch{console.log('?')}})")
  echo -e "${GREEN}✅ Scratchy is running — version: ${VERSION}${NC}"
elif [ "$HTTP_CODE" = "000" ] || [ "$HTTP_CODE" = "404" ]; then
  # /api/version may not exist yet — fall back to /
  FALLBACK_CODE=$(curl -s -o /dev/null -w "%{http_code}" http://localhost:3001/ 2>/dev/null || echo "000")
  if [ "$FALLBACK_CODE" = "200" ]; then
    echo -e "${GREEN}✅ Scratchy is running (/ responded 200, /api/version not yet available)${NC}"
  else
    echo -e "${RED}❌ Health check failed (HTTP $FALLBACK_CODE on /)${NC}"
    echo -e "Check logs: ${YELLOW}journalctl --user -u scratchy -n 50${NC}"
    exit 1
  fi
else
  echo -e "${RED}❌ Health check failed (HTTP $HTTP_CODE)${NC}"
  echo -e "Check logs: ${YELLOW}journalctl --user -u scratchy -n 50${NC}"
  exit 1
fi

# ─── 8. Stage version snapshot ───────────────────────────────────────

echo -e "${BLUE}📦 Staging version snapshot...${NC}"

# Read gateway token for API auth
GATEWAY_TOKEN=""
if [ -f "$HOME/.openclaw/openclaw.json" ]; then
  GATEWAY_TOKEN=$(node -e "try{const c=JSON.parse(require('fs').readFileSync('$HOME/.openclaw/openclaw.json','utf-8'));console.log(c.gateway?.auth?.token||'')}catch{}" 2>/dev/null)
fi

if [ -n "$GATEWAY_TOKEN" ]; then
  STAGE_DESC="${TAG:-deploy $(date +%Y-%m-%d_%H:%M)}"
  STAGE_TAG_ARG=""
  if [ -n "$TAG" ]; then
    STAGE_TAG_ARG=", \"tag\": \"$TAG\""
  fi

  STAGE_RESULT=$(curl -s -X POST http://localhost:3001/api/deploy/stage \
    -H "Authorization: Bearer $GATEWAY_TOKEN" \
    -H "Content-Type: application/json" \
    -d "{\"description\": \"$STAGE_DESC\"$STAGE_TAG_ARG}" 2>/dev/null)

  STAGE_OK=$(echo "$STAGE_RESULT" | node -e "process.stdin.on('data',d=>{try{const r=JSON.parse(d);console.log(r.ok?'yes':'no')}catch{console.log('no')}})")

  if [ "$STAGE_OK" = "yes" ]; then
    STAGED_TAG=$(echo "$STAGE_RESULT" | node -e "process.stdin.on('data',d=>{try{console.log(JSON.parse(d).version.tag)}catch{console.log('?')}})")
    echo -e "${GREEN}✅ Version staged: ${STAGED_TAG}${NC}"
    echo -e "  ${YELLOW}⚠ Version is staged only — push to users via Deploy Manager widget${NC}"
  else
    echo -e "${YELLOW}⚠ Failed to stage version: ${STAGE_RESULT}${NC}"
  fi
else
  echo -e "${YELLOW}⚠ No gateway token found — skipping version staging${NC}"
fi

echo ""

# ─── 9. Summary ─────────────────────────────────────────────────────

echo ""
echo -e "${GREEN}═══════════════════════════════${NC}"
echo -e "${GREEN}  🐱 Deploy complete!${NC}"
echo -e "${GREEN}═══════════════════════════════${NC}"
echo -e "  ${YELLOW}Remember: push to users via Deploy Manager${NC}"
echo ""
