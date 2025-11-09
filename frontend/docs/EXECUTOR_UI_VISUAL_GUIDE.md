# Executor UI Controls - Visual Guide

## 🎨 UI Component Preview

### State 1: Executor Not Running
```
╔══════════════════════════════════════════════════════════╗
║  Auto-Executor    ○ Not Running              ▶ Show     ║
╠══════════════════════════════════════════════════════════╣
║                                                          ║
║  [ ▶ Start Executor ]                                    ║
║                                                          ║
╚══════════════════════════════════════════════════════════╝
```

### State 2: Executor Active (Collapsed)
```
╔══════════════════════════════════════════════════════════╗
║  Auto-Executor    ● Active (pulsing)         ▶ Show     ║
╠══════════════════════════════════════════════════════════╣
║                                                          ║
║  [ ⏸ Pause ]  [ ⏹ Stop ]                                ║
║                                                          ║
║  ┌─────────────────┬────────────────┬─────────────────┐ ║
║  │  Executions     │  Success Rate  │  In Flight      │ ║
║  │  ─────────────  │  ────────────  │  ─────────────  │ ║
║  │      42         │     90.5%      │       0         │ ║
║  └─────────────────┴────────────────┴─────────────────┘ ║
║                                                          ║
╚══════════════════════════════════════════════════════════╝
```

### State 3: Executor Active (Expanded)
```
╔══════════════════════════════════════════════════════════╗
║  Auto-Executor    ● Active (pulsing)         ▼ Hide     ║
╠══════════════════════════════════════════════════════════╣
║                                                          ║
║  [ ⏸ Pause ]  [ ⏹ Stop ]                                ║
║                                                          ║
║  ┌─────────────────┬────────────────┬─────────────────┐ ║
║  │  Executions     │  Success Rate  │  In Flight      │ ║
║  │  ─────────────  │  ────────────  │  ─────────────  │ ║
║  │      42         │     90.5%      │       0         │ ║
║  └─────────────────┴────────────────┴─────────────────┘ ║
║                                                          ║
║  ╔═══════════════════════════════════════════════════╗  ║
║  ║  Configuration                                    ║  ║
║  ║  ─────────────────────────────────────────────    ║  ║
║  ║                                                   ║  ║
║  ║  Min Profit: 0.50%         Trade Size: $100      ║  ║
║  ║  Slippage: 0.50%           Max Concurrent: 1     ║  ║
║  ║  Cooldown: 5.0s            Max/Min: 10           ║  ║
║  ║                                                   ║  ║
║  ║  Statistics                                       ║  ║
║  ║  ─────────────────────────────────────────────    ║  ║
║  ║                                                   ║  ║
║  ║  Total: 42                 Success: 38           ║  ║
║  ║  Failed: 4                 This Minute: 3        ║  ║
║  ║                                                   ║  ║
║  ╚═══════════════════════════════════════════════════╝  ║
║                                                          ║
╚══════════════════════════════════════════════════════════╝
```

### State 4: Executor Paused
```
╔══════════════════════════════════════════════════════════╗
║  Auto-Executor    ● Paused                   ▶ Show     ║
╠══════════════════════════════════════════════════════════╣
║                                                          ║
║  [ ▶ Resume ]  [ ⏹ Stop ]                               ║
║                                                          ║
║  ┌─────────────────┬────────────────┬─────────────────┐ ║
║  │  Executions     │  Success Rate  │  In Flight      │ ║
║  │  ─────────────  │  ────────────  │  ─────────────  │ ║
║  │      42         │     90.5%      │       0         │ ║
║  └─────────────────┴────────────────┴─────────────────┘ ║
║                                                          ║
╚══════════════════════════════════════════════════════════╝
```

### State 5: Error State
```
╔══════════════════════════════════════════════════════════╗
║  Auto-Executor    ○ Not Running              ▶ Show     ║
╠══════════════════════════════════════════════════════════╣
║  ╔═══════════════════════════════════════════════════╗  ║
║  ║  ⚠ Failed to start executor                      ║  ║
║  ║  Connection refused - is the backend running?     ║  ║
║  ╚═══════════════════════════════════════════════════╝  ║
║                                                          ║
║  [ ▶ Start Executor ]                                    ║
║                                                          ║
╚══════════════════════════════════════════════════════════╝
```

## 🎬 User Interaction Flow

### Starting the Executor
```
User clicks "▶ Start Executor"
           ↓
Button shows "Starting..."
           ↓
POST /arb/executor/start
           ↓
Backend starts executor
           ↓
Status updates to "Active"
           ↓
Stats appear (Executions: 0, Success: 0%)
```

### Execution Lifecycle
```
arb-rs detects opportunity
           ↓
Executor filters & validates
           ↓
"In Flight" counter: 0 → 1
           ↓
Transaction executes
           ↓
Socket event: arb:execution
           ↓
"Executions" counter: 42 → 43
"Success Rate" updates: 90.5% → 90.7%
"In Flight" counter: 1 → 0
```

### Pausing
```
User clicks "⏸ Pause"
           ↓
POST /arb/executor/config { enabled: false }
           ↓
Status updates to "Paused"
           ↓
No new executions (but still monitoring)
           ↓
User clicks "▶ Resume"
           ↓
POST /arb/executor/config { enabled: true }
           ↓
Status updates to "Active"
           ↓
Executions resume
```

## 🎨 Color Scheme

### Status Indicators
- 🟢 **Green Pulsing** - Active and executing
- 🟡 **Yellow** - Paused (running but disabled)
- ⚫ **Gray** - Stopped / Not running

### Buttons
- **Green** (`bg-green-600`) - Start, Resume
- **Yellow** (`bg-yellow-600`) - Pause
- **Red** (`bg-red-600`) - Stop
- **Gray** (`border`) - Expand/Collapse

### Stats
- **Green text** - Success metrics
- **Red text** - Failed metrics
- **White** - Neutral stats

### Background
- Gradient: `from-purple-900/20 to-blue-900/20`
- Dark overlay: `bg-black/20` for stat boxes

## 📱 Responsive Behavior

### Desktop (>768px)
- Full 2-column grid for configuration
- All stats visible
- Wide button layout

### Mobile (<768px)
- Single column layout
- Stacked buttons
- Compact stat display
- Collapsible by default

## 🔄 Real-Time Updates

### Update Sources
1. **Polling (3s interval)**
   - GET /arb/executor/status
   - Updates all metrics

2. **Socket Events (instant)**
   - `arb:execution` → Refresh status
   - `arb:execution:failed` → Refresh status

### What Updates
- ✅ Execution counters
- ✅ Success/failure rates
- ✅ In-flight count
- ✅ Per-minute counter
- ✅ Running/enabled status

## 🎯 Click Targets

All interactive elements with minimum 44x44px touch targets:
- [▶ Start Executor] - Full width button
- [⏸ Pause] - Medium button
- [⏹ Stop] - Medium button
- [▶ Show / ▼ Hide] - Small button (right-aligned)

## 📊 Data Flow

```
┌──────────────┐
│   Backend    │
│   Executor   │
└──────┬───────┘
       │
       ├─→ REST API Status
       │   (polled every 3s)
       │
       └─→ Socket.IO Events
           (instant push)
              ↓
       ┌─────────────┐
       │  Frontend   │
       │  Component  │
       └─────────────┘
              ↓
       State Updates
              ↓
       ┌─────────────┐
       │ UI Renders  │
       │ New Stats   │
       └─────────────┘
```

## 🎉 Final Result

The UI now provides:
- ✅ **Instant visibility** - See executor status at a glance
- ✅ **One-click control** - Start, pause, stop with single clicks
- ✅ **Real-time feedback** - Live updates as executions happen
- ✅ **Detailed insights** - Expand to see full config and stats
- ✅ **Error handling** - Clear error messages if something fails
- ✅ **Responsive design** - Works on desktop and mobile

Users can now manage their arbitrage executor without touching the command line! 🚀

