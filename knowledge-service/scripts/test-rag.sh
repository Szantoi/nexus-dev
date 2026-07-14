#!/bin/bash
# RAG Validation Tests

set -e

BASE_URL="http://localhost:3456"

echo "🧪 Testing SpaceOS Knowledge Service RAG"
echo "=========================================="
echo ""

# Test 1: Health endpoint
echo "Test 1: Health endpoint"
HEALTH=$(curl -s "$BASE_URL/health")
echo "✓ Health: $HEALTH"
echo ""

# Test 2: Search for RLS (database security pattern)
echo "Test 2: Search for 'RLS' (Row Level Security)"
RESULT=$(curl -s "$BASE_URL/api/knowledge/search?q=RLS&topK=3")
MATCHES=$(echo "$RESULT" | grep -o '"source":' | wc -l)
if [ "$MATCHES" -gt 0 ]; then
  echo "✓ Found $MATCHES results for 'RLS'"
else
  echo "✗ No results found for 'RLS'"
  exit 1
fi
echo ""

# Test 3: Search for ChromaDB
echo "Test 3: Search for 'ChromaDB'"
RESULT=$(curl -s "$BASE_URL/api/knowledge/search?q=ChromaDB&topK=3")
MATCHES=$(echo "$RESULT" | grep -o '"source":' | wc -l)
if [ "$MATCHES" -gt 0 ]; then
  echo "✓ Found $MATCHES results for 'ChromaDB'"
else
  echo "✗ No results found for 'ChromaDB'"
  exit 1
fi
echo ""

# Test 4: Search for EF Core migration
echo "Test 4: Search for 'EF Core migration'"
RESULT=$(curl -s -X POST "$BASE_URL/api/knowledge/search" \
  -H "Content-Type: application/json" \
  -d '{"q":"EF Core migration","topK":3}')
MATCHES=$(echo "$RESULT" | grep -o '"source":' | wc -l)
if [ "$MATCHES" -gt 0 ]; then
  echo "✓ Found $MATCHES results for 'EF Core migration'"
else
  echo "✗ No results found for 'EF Core migration'"
  exit 1
fi
echo ""

# Test 5: Search for React component
echo "Test 5: Search for 'React component'"
RESULT=$(curl -s "$BASE_URL/api/knowledge/search?q=React%20component&topK=3")
MATCHES=$(echo "$RESULT" | grep -o '"source":' | wc -l)
if [ "$MATCHES" -gt 0 ]; then
  echo "✓ Found $MATCHES results for 'React component'"
else
  echo "✗ No results found for 'React component'"
  exit 1
fi
echo ""

echo "=========================================="
echo "✅ All 5 tests passed!"
echo ""
