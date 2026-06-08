const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const { LiveChat } = require("youtube-chat");
const fs = require("fs");
const path = require("path");

// ─── CONFIG ───────────────────────────────────────────────────────────────────
const YOUTUBE_CHANNEL_ID = "YOUR_CHANNEL_ID"; // ← replace with your YouTube channel ID
const VOTE_DURATION_MS = 20000;               // 20 seconds per round
const RESTART_DELAY_MS = 30000;               // 30 seconds after puzzle completion
const GRID_SIZE = 3;
const TOTAL_CELLS = GRID_SIZE * GRID_SIZE;    // 9
const TOTAL_TILES = TOTAL_CELLS - 1;          // 8
const IMAGES_DIR = path.join(__dirname, "images");
const PORT = 3000;
// ──────────────────────────────────────────────────────────────────────────────

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, "public")));
app.use("/images", express.static(IMAGES_DIR));

// ─── PUZZLE STATE ─────────────────────────────────────────────────────────────
let board = [];         // 1D array of 9 cells: value = tile (1-8) or 0 (blank)
let emptyPos = TOTAL_TILES; // blank starts at index 8
let currentImage = null;
let moveCount = 0;
let roundStartTime = null;
let votes = {};         // { cellIndex: { count, firstTime, voters: Set } }
let allVoters = {};     // { username: contributionCount } for this puzzle
let voteTimer = null;
let restartTimer = null;
let currentMovable = [];
let puzzleComplete = false;
let completeStats = null;

// ─── IMAGE HELPERS ────────────────────────────────────────────────────────────
function getImageList() {
  if (!fs.existsSync(IMAGES_DIR)) fs.mkdirSync(IMAGES_DIR, { recursive: true });
  return fs.readdirSync(IMAGES_DIR).filter(f =>
    /\.(jpg|jpeg|png|gif|webp)$/i.test(f)
  );
}

function pickRandomImage() {
  const list = getImageList();
  if (list.length === 0) return null;
  return list[Math.floor(Math.random() * list.length)];
}

// ─── BOARD LOGIC ──────────────────────────────────────────────────────────────
function initBoard() {
  board = Array.from({ length: TOTAL_CELLS }, (_, i) => (i < TOTAL_TILES ? i + 1 : 0));
  emptyPos = TOTAL_TILES; // blank at index 8
  shuffleBoard();
}

function shuffleBoard() {
  // 300 random valid moves — guarantees solvability
  for (let i = 0; i < 300; i++) {
    const neighbors = getMovableNeighbors();
    applyMove(neighbors[Math.floor(Math.random() * neighbors.length)]);
  }
  // Re-shuffle if accidentally solved
  if (isSolved()) shuffleBoard();
}

function getMovableNeighbors() {
  const row = Math.floor(emptyPos / GRID_SIZE);
  const col = emptyPos % GRID_SIZE;
  const candidates = [];
  if (row > 0) candidates.push(emptyPos - GRID_SIZE);
  if (row < GRID_SIZE - 1) candidates.push(emptyPos + GRID_SIZE);
  if (col > 0) candidates.push(emptyPos - 1);
  if (col < GRID_SIZE - 1) candidates.push(emptyPos + 1);
  return candidates;
}

function applyMove(tileIndex) {
  board[emptyPos] = board[tileIndex];
  board[tileIndex] = 0;
  emptyPos = tileIndex;
}

function isSolved() {
  for (let i = 0; i < TOTAL_TILES; i++) {
    if (board[i] !== i + 1) return false;
  }
  return board[TOTAL_TILES] === 0;
}

function buildTop5() {
  return Object.entries(allVoters)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([name, count]) => ({ name, count }));
}

function finishPuzzle() {
  puzzleComplete = true;
  completeStats = {
    elapsed: Math.floor((Date.now() - roundStartTime) / 1000),
    moveCount,
    top5: buildTop5(),
    restartAt: Date.now() + RESTART_DELAY_MS,
  };

  io.emit("puzzle_complete", completeStats);

  if (restartTimer) clearTimeout(restartTimer);
  restartTimer = setTimeout(() => {
    restartTimer = null;
    newPuzzle();
  }, RESTART_DELAY_MS);
}

// ─── LABEL HELPERS ────────────────────────────────────────────────────────────
// cellLabel(0)="A1", cellLabel(4)="B2", etc.
function cellLabel(index) {
  const col = String.fromCharCode(65 + (index % GRID_SIZE)); // A B C
  const row = Math.floor(index / GRID_SIZE) + 1;             // 1 2 3
  return `${col}${row}`;
}

// Parse "!B2" → board index, or null if invalid
function parseVote(text) {
  const match = text.trim().match(/^!([A-Ca-c])([1-3])$/);
  if (!match) return null;
  const col = match[1].toUpperCase().charCodeAt(0) - 65; // A=0 B=1 C=2
  const row = parseInt(match[2], 10) - 1;               // 1→0, 2→1, 3→2
  return row * GRID_SIZE + col;
}

// ─── VOTE CYCLE ───────────────────────────────────────────────────────────────
function startVoteCycle() {
  if (puzzleComplete) return;

  votes = {};
  currentMovable = getMovableNeighbors();

  io.emit("vote_start", {
    board: [...board],
    emptyPos,
    movable: currentMovable,
    movableLabels: currentMovable.map(cellLabel),
    duration: VOTE_DURATION_MS,
  });

  voteTimer = setTimeout(resolveVotes, VOTE_DURATION_MS);
}

function resolveVotes() {
  const movableSet = new Set(currentMovable);

  // Only count votes for valid (movable) cells
  const validVotes = Object.entries(votes)
    .filter(([cell]) => movableSet.has(Number(cell)))
    .map(([cell, data]) => ({ cell: Number(cell), ...data }));

  // Build snapshot for all movable cells (including zeros)
  const voteSnapshot = currentMovable.map(idx => ({
    label: cellLabel(idx),
    index: idx,
    count: votes[idx]?.count || 0,
  }));

  let chosenCell = null;

  if (validVotes.length > 0) {
    // Sort: highest count first, then earliest first vote breaks ties
    validVotes.sort((a, b) =>
      b.count !== a.count ? b.count - a.count : a.firstTime - b.firstTime
    );
    chosenCell = validVotes[0].cell;
  }

  if (chosenCell !== null) {
    // Credit every voter who voted for the winning cell (one credit per person)
    const winners = votes[chosenCell]?.voters || new Set();
    winners.forEach(u => {
      allVoters[u] = (allVoters[u] || 0) + 1;
    });

    applyMove(chosenCell);
    moveCount++;

    io.emit("move_made", {
      board: [...board],
      emptyPos,
      movedCell: chosenCell,
      movedLabel: cellLabel(chosenCell),
      voteSnapshot,
      moveCount,
    });
  } else {
    io.emit("no_votes", {
      board: [...board],
      emptyPos,
      voteSnapshot,
    });
  }

  // Check win AFTER emitting move
  if (isSolved()) {
    finishPuzzle();
  } else {
    setTimeout(startVoteCycle, 1500);
  }
}

// ─── CHAT INTEGRATION ─────────────────────────────────────────────────────────
function startChat() {
  const liveChat = new LiveChat({ channelId: YOUTUBE_CHANNEL_ID });

  liveChat.on("chat", (chatItem) => {
    if (puzzleComplete || consoleOverride) return;
    const text = chatItem.message?.map(m => m.text || "").join("") || "";
    const cellIndex = parseVote(text);
    if (cellIndex === null) return;

    const username = chatItem.author?.name || "unknown";

    if (!votes[cellIndex]) {
      votes[cellIndex] = { count: 0, firstTime: Date.now(), voters: new Set() };
    }

    // One vote per user per round
    if (!votes[cellIndex].voters.has(username)) {
      votes[cellIndex].voters.add(username);
      votes[cellIndex].count++;

      io.emit("vote_cast", {
        username,
        label: cellLabel(cellIndex),
        index: cellIndex,
        currentCount: votes[cellIndex].count,
      });
    }
  });

  liveChat.on("error", (err) => console.error("[LiveChat error]", err));
  liveChat.start().then(ok => {
    if (!ok) console.warn("[LiveChat] Failed — check channel ID and that stream is live.");
    else console.log("[LiveChat] Connected to YouTube chat.");
  });
}

// ─── SOCKET CONNECTION ────────────────────────────────────────────────────────
io.on("connection", (socket) => {
  console.log("[Socket] Client connected");

  // Full state sync so reconnecting overlays catch up immediately
  socket.emit("state_sync", {
    board: [...board],
    emptyPos,
    currentImage,
    moveCount,
    roundStartTime,
    puzzleComplete,
    movable: currentMovable,
    movableLabels: currentMovable.map(cellLabel),
    completeStats,
  });
});

// ─── NEW PUZZLE ───────────────────────────────────────────────────────────────
function newPuzzle() {
  if (voteTimer) clearTimeout(voteTimer);
  if (restartTimer) clearTimeout(restartTimer);
  voteTimer = null;
  restartTimer = null;
  puzzleComplete = false;
  completeStats = null;
  moveCount = 0;
  allVoters = {};
  votes = {};
  currentMovable = [];
  currentImage = pickRandomImage();
  initBoard();
  roundStartTime = Date.now();

  io.emit("new_puzzle", { board: [...board], emptyPos, currentImage });
  setTimeout(startVoteCycle, 2000);
}

// ─── START ────────────────────────────────────────────────────────────────────
server.listen(PORT, () => {
  console.log(`[Server] Running at http://localhost:${PORT}`);
  newPuzzle();
  startChat();
});

// ─── CONSOLE COMMANDS ────────────────────────────────────────────────────────
// new        → start a fresh puzzle
// move B2    → force move cell B2, cancels current vote window
// board      → print current board state to console

let consoleOverride = false; // flag so chat votes are ignored during override

function forceMove(input) {
  const match = input.match(/^move\s+([A-Ca-c])([1-3])$/i);
  if (!match) {
    console.log("[Console] Usage: move B2  (column A-C, row 1-3)");
    return;
  }

  if (puzzleComplete) {
    console.log("[Console] Puzzle already complete. Type 'new' to start a new one.");
    return;
  }

  const col = match[1].toUpperCase().charCodeAt(0) - 65;
  const row = parseInt(match[2], 10) - 1;
  const cellIndex = row * GRID_SIZE + col;
  const label = cellLabel(cellIndex);

  if (!currentMovable.includes(cellIndex)) {
    const validLabels = currentMovable.map(cellLabel).join(", ");
    console.log(`[Console] Cell ${label} is not movable. Valid cells: ${validLabels}`);
    return;
  }

  // Cancel the current vote timer
  if (voteTimer) { clearTimeout(voteTimer); voteTimer = null; }

  // Suppress chat votes during the forced move resolution
  consoleOverride = true;

  const voteSnapshot = currentMovable.map(idx => ({
    label: cellLabel(idx),
    index: idx,
    count: 0,
  }));

  applyMove(cellIndex);
  moveCount++;
  console.log(`[Console] Forced move → ${label}. Total moves: ${moveCount}`);

  io.emit("move_made", {
    board: [...board],
    emptyPos,
    movedCell: cellIndex,
    movedLabel: label,
    voteSnapshot,
    moveCount,
  });

  consoleOverride = false;

  if (isSolved()) {
    finishPuzzle();
    console.log(`[Console] Puzzle solved! Time: ${completeStats.elapsed}s, Moves: ${moveCount}`);
  } else {
    setTimeout(startVoteCycle, 1500);
  }
}

function forceWin() {
  if (puzzleComplete) {
    console.log("[Console] Puzzle already complete. Type 'new' to start a new one.");
    return;
  }

  if (voteTimer) { clearTimeout(voteTimer); voteTimer = null; }

  board = Array.from({ length: TOTAL_CELLS }, (_, i) => (i < TOTAL_TILES ? i + 1 : 0));
  emptyPos = TOTAL_TILES;
  currentMovable = [];
  votes = {};

  io.emit("state_sync", {
    board: [...board],
    emptyPos,
    currentImage,
    moveCount,
    roundStartTime,
    puzzleComplete: false,
    movable: currentMovable,
    movableLabels: [],
    completeStats: null,
  });

  finishPuzzle();
  console.log(`[Console] Forced win! Time: ${completeStats.elapsed}s, Moves: ${moveCount}`);
}

function addConsoleVote(input) {
  if (puzzleComplete) {
    console.log("[Console] Puzzle already complete. Type 'new' to start a new one.");
    return;
  }

  const match = input.match(/^vote\s+([A-Ca-c])([1-3])$/i);
  if (!match) {
    console.log("[Console] Usage: vote A2");
    return;
  }

  if (!voteTimer || currentMovable.length === 0) {
    console.log("[Console] There is no active vote window right now.");
    return;
  }

  const col = match[1].toUpperCase().charCodeAt(0) - 65;
  const row = parseInt(match[2], 10) - 1;
  const cellIndex = row * GRID_SIZE + col;
  const label = cellLabel(cellIndex);

  if (!currentMovable.includes(cellIndex)) {
    const validLabels = currentMovable.map(cellLabel).join(", ");
    console.log(`[Console] Cell ${label} is not movable. Valid cells: ${validLabels}`);
    return;
  }

  if (!votes[cellIndex]) {
    votes[cellIndex] = { count: 0, firstTime: Date.now(), voters: new Set() };
  }

  votes[cellIndex].count++;

  io.emit("vote_cast", {
    username: "Console",
    label,
    index: cellIndex,
    currentCount: votes[cellIndex].count,
  });

  console.log(`[Console] Added 1 vote to ${label}. Total votes: ${votes[cellIndex].count}`);
}

function printBoard() {
  console.log("\n  A  B  C");
  for (let r = 0; r < GRID_SIZE; r++) {
    let row = `${r + 1} `;
    for (let c = 0; c < GRID_SIZE; c++) {
      const v = board[r * GRID_SIZE + c];
      row += v === 0 ? " __ " : ` ${String(v).padStart(2, "0")} `;
    }
    console.log(row);
  }
  const movable = currentMovable.map(cellLabel).join(", ");
  console.log(`  Movable: ${movable}\n`);
}

process.stdin.setEncoding("utf8");
process.stdin.on("data", d => {
  const cmd = d.trim().toLowerCase();
  if (cmd === "new") {
    console.log("[Console] Starting new puzzle...");
    newPuzzle();
  } else if (cmd.startsWith("move ")) {
    forceMove(cmd);
  } else if (cmd.startsWith("vote ")) {
    addConsoleVote(cmd);
  } else if (cmd === "win") {
    forceWin();
  } else if (cmd === "board") {
    printBoard();
  } else if (cmd === "help" || cmd === "?") {
    console.log("\nCommands:");
    console.log("  win        - instantly end the current puzzle as solved");
    console.log("  vote A2    - add 1 vote to a movable tile");
    console.log("  new        — start a fresh puzzle with a new image");
    console.log("  move B2    — force-move cell B2 (skips chat votes)");
    console.log("  board      — print current board layout\n");
  } else {
    console.log(`[Console] Unknown command: "${cmd}". Type 'help' for commands.`);
  }
});
