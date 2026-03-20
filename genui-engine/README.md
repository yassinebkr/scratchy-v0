# Scratchy Intent Classifier Prototype

**Goal**: Classify user messages into 8 layout types in <500ms for Tier 1 instant response.

## Architecture

### 3-Tier System
- **Tier 1**: Instant templates (<200ms) - 8 optimized layouts
- **Tier 2**: Smart intent classifier (<500ms) - this prototype  
- **Tier 3**: Full creative flexibility (1-2s) - existing system

### 8 Layout Types (Tier 1)
1. **dashboard** - metrics, status overview, KPIs
2. **form** - input, composition, data entry
3. **status** - system state, progress, health checks
4. **detail** - item view, info display, deep dive
5. **timeline** - events, history, chronological data
6. **chart** - data visualization, graphs, analytics
7. **email** - communication, messaging, composition
8. **checklist** - tasks, todos, completion tracking

## Performance Target
- **Classification**: <500ms
- **Confidence scoring**: 0.0-1.0 (fallback to Tier 3 if <0.7)
- **Training data**: Generated samples for each layout type
- **Model**: Lightweight embeddings (sentence-transformers or similar)

## Implementation Strategy
1. Generate training data for each layout type
2. Build embedding-based classifier
3. Benchmark performance
4. Integration with Scratchy canvas system

## Files
- `classifier.js` - Main classifier implementation
- `training-data.json` - Generated training samples
- `benchmark.js` - Performance testing
- `integration.md` - Scratchy integration plan