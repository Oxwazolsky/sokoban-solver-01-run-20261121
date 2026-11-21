// Push-optimal Sokoban solver for make.fun's sokoban-solver-01.
//
// Why this shape: the contest levels are a hallway with small rooms off it, and a box can never
// leave its room, so a level's push optimum is the sum of its rooms' optima. This solver cuts a
// level into its rooms, solves each room exactly with a breadth-first search over pushes (so the
// first solution found is push-optimal), and stitches the rooms together with the player's walks.
// A reward needs a score above the house baseline's move-level A*, which spends its budget on
// whole levels; solving room by room is both exact and far cheaper.
//
// Deterministic by construction: no clock, no randomness, fixed direction order everywhere, and
// every search budget is a count of states, never a time. Two runs answer byte for byte alike.
//
// Local run: mkdir -p out && MAKEFUN_INPUT_DIR=practice/input MAKEFUN_OUTPUT_DIR=out node main.ts
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const IN_DIR = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const OUT_DIR = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

// Directions in a fixed order: up, down, left, right. A push is written with the capital letter.
const DIRS = [
  { dx: 0, dy: -1, walk: 'u', push: 'U' },
  { dx: 0, dy: 1, walk: 'd', push: 'D' },
  { dx: -1, dy: 0, walk: 'l', push: 'L' },
  { dx: 1, dy: 0, walk: 'r', push: 'R' },
] as const;

// The most states one room search keeps before it gives up (work, never the clock). The levels'
// rooms are small (at most four boxes in a 6 by 6 slot), so an exact search stays far under this.
const MAX_STATES = 4_000_000;

interface Board {
  w: number;
  size: number;
  wall: Uint8Array;
  goals: number[]; // sorted
  boxes: number[]; // sorted
  player: number;
}

/** A level in XSB text: walls, goals, boxes and the player. Short rows and the frame are walls. */
function parseLevel(text: string): Board {
  const rows = text.split('\n').filter((r) => r.length > 0);
  const h = rows.length;
  const w = Math.max(...rows.map((r) => r.length));
  const size = w * h;
  const wall = new Uint8Array(size).fill(1);
  const goals: number[] = [];
  const boxes: number[] = [];
  let player = -1;
  rows.forEach((row, y) => {
    for (let x = 0; x < row.length; x++) {
      const ch = row[x];
      const i = y * w + x;
      if (ch === '#') continue;
      wall[i] = 0;
      if (ch === '.' || ch === '*' || ch === '+') goals.push(i);
      if (ch === '$' || ch === '*') boxes.push(i);
      if (ch === '@' || ch === '+') player = i;
    }
  });
  for (let x = 0; x < w; x++) {
    wall[x] = 1;
    wall[size - w + x] = 1;
  }
  for (let y = 0; y < h; y++) {
    wall[y * w] = 1;
    wall[y * w + w - 1] = 1;
  }
  goals.sort((a, b) => a - b);
  boxes.sort((a, b) => a - b);
  return { w, size, wall, goals, boxes, player };
}

/**
 * The squares a lone box can be pushed from onto some goal, found by pulling boxes back from the
 * goals over open floor. A box on any other square can never reach a goal: those squares are dead.
 */
function liveSquares(w: number, wall: Uint8Array, goals: number[]): Uint8Array {
  const live = new Uint8Array(wall.length);
  const queue: number[] = [];
  for (const g of goals) {
    live[g] = 1;
    queue.push(g);
  }
  for (let qi = 0; qi < queue.length; qi++) {
    const at = queue[qi];
    for (const { dx, dy } of DIRS) {
      const d = dy * w + dx;
      const from = at - d; // a box here can be pushed onto `at`...
      const stand = at - 2 * d; // ...by a player standing here
      if (!wall[from] && !wall[stand] && !live[from]) {
        live[from] = 1;
        queue.push(from);
      }
    }
  }
  return live;
}

/**
 * Flood the player's reachable region from `from` around walls and the boxes in `blocked`,
 * stamping squares in `seen` with `stamp`. Returns the region's lowest square, its canonical name.
 */
function floodRegion(
  w: number,
  wall: Uint8Array,
  blocked: Uint8Array,
  from: number,
  seen: Int32Array,
  stamp: number,
  stack: Int32Array,
): number {
  let low = from;
  let n = 0;
  stack[n++] = from;
  seen[from] = stamp;
  while (n > 0) {
    const p = stack[--n];
    if (p < low) low = p;
    const up = p - w;
    const down = p + w;
    const left = p - 1;
    const right = p + 1;
    if (!wall[up] && !blocked[up] && seen[up] !== stamp) { seen[up] = stamp; stack[n++] = up; }
    if (!wall[down] && !blocked[down] && seen[down] !== stamp) { seen[down] = stamp; stack[n++] = down; }
    if (!wall[left] && !blocked[left] && seen[left] !== stamp) { seen[left] = stamp; stack[n++] = left; }
    if (!wall[right] && !blocked[right] && seen[right] !== stamp) { seen[right] = stamp; stack[n++] = right; }
  }
  return low;
}

/** Whether the box just pushed onto `t` froze into a 2x2 block of walls and boxes, off its goal. */
function frozenBlock(
  w: number,
  wall: Uint8Array,
  blocked: Uint8Array,
  onGoal: Uint8Array,
  t: number,
): boolean {
  for (const a of [t, t - 1, t - w, t - w - 1]) {
    const b = a + 1;
    const c = a + w;
    const d = c + 1;
    const solid = (s: number) => wall[s] === 1 || blocked[s] === 1;
    if (!solid(a) || !solid(b) || !solid(c) || !solid(d)) continue;
    const stuckOffGoal = (s: number) => blocked[s] === 1 && onGoal[s] === 0;
    if (stuckOffGoal(a) || stuckOffGoal(b) || stuckOffGoal(c) || stuckOffGoal(d)) return true;
  }
  return false;
}

/** The shortest walk from `from` to `to` around walls and boxes, as lower-case LURD letters. */
function walkPath(
  w: number,
  wall: Uint8Array,
  blocked: Uint8Array,
  from: number,
  to: number,
): string {
  if (from === to) return '';
  const size = wall.length;
  const prev = new Int32Array(size).fill(-1);
  const letter = new Array<string>(size);
  const queue = new Int32Array(size);
  let qh = 0;
  let qt = 0;
  queue[qt++] = from;
  prev[from] = from;
  while (qh < qt) {
    const p = queue[qh++];
    if (p === to) break;
    for (const { dx, dy, walk } of DIRS) {
      const q = p + dy * w + dx;
      if (wall[q] || blocked[q] || prev[q] !== -1) continue;
      prev[q] = p;
      letter[q] = walk;
      queue[qt++] = q;
    }
  }
  if (prev[to] === -1) throw new Error('walkPath: target out of reach');
  let out = '';
  for (let p = to; p !== from; p = prev[p]) out = letter[p] + out;
  return out;
}

/**
 * One room solved push-optimally by breadth-first search over pushes, or null when the search
 * gives up. A state is the room's boxes plus the canonical name of the player's region, so states
 * that differ only in where the player stands inside one region are the same state. Pushes onto
 * dead squares and pushes that freeze a 2x2 block are pruned; neither can lose the optimum.
 */
function solveRoom(board: Board): { pushes: number; moves: string } | null {
  const { w, size, wall, goals } = board;
  const n = board.boxes.length;
  const onGoal = new Uint8Array(size);
  for (const g of goals) onGoal[g] = 1;
  const live = liveSquares(w, wall, goals);
  if (board.boxes.some((b) => !live[b])) return null;
  const solved = (bs: number[]) => bs.every((b) => onGoal[b] === 1);
  if (solved(board.boxes)) return { pushes: 0, moves: '' };

  const blocked = new Uint8Array(size);
  const seen = new Int32Array(size); // the region of the state being expanded
  const mark = new Int32Array(size); // the region of a child state a push makes
  const stack = new Int32Array(size);
  let stamp = 0;

  // States in the order found; a state's parent and the push that made it rebuild the answer.
  const flat: number[] = []; // every state's boxes, n per state
  const statePlayer: number[] = []; // the square the player stands on in the state
  const stateParent: number[] = [];
  const keyOf = (bs: number[], low: number): string => `${low}|${bs.join(',')}`;
  const index = new Map<string, number>();

  for (const b of board.boxes) blocked[b] = 1;
  const startLow = floodRegion(w, wall, blocked, board.player, seen, ++stamp, stack);
  for (const b of board.boxes) blocked[b] = 0;
  flat.push(...board.boxes);
  statePlayer.push(board.player);
  stateParent.push(-1);
  index.set(keyOf(board.boxes, startLow), 0);

  let found = -1;
  for (let head = 0; head < statePlayer.length && found < 0; head++) {
    const boxes = flat.slice(head * n, head * n + n);
    for (const b of boxes) blocked[b] = 1;
    floodRegion(w, wall, blocked, statePlayer[head], seen, ++stamp, stack);
    const regionStamp = stamp;
    for (let bi = 0; bi < n && found < 0; bi++) {
      const b = boxes[bi];
      for (const { dx, dy } of DIRS) {
        const d = dy * w + dx;
        const stand = b - d;
        const dest = b + d;
        if (seen[stand] !== regionStamp || wall[dest] || blocked[dest] || !live[dest]) continue;
        blocked[b] = 0;
        blocked[dest] = 1;
        const frozen = frozenBlock(w, wall, blocked, onGoal, dest);
        let key = '';
        let next: number[] | null = null;
        let low = -1;
        if (!frozen) {
          next = boxes.slice();
          next[bi] = dest;
          next.sort((a, b2) => a - b2);
          low = floodRegion(w, wall, blocked, b, mark, ++stamp, stack);
          key = keyOf(next, low);
        }
        blocked[dest] = 0;
        blocked[b] = 1;
        if (frozen || index.has(key)) continue;
        if (statePlayer.length >= MAX_STATES) {
          for (const x of boxes) blocked[x] = 0;
          return null;
        }
        index.set(key, statePlayer.length);
        flat.push(...next!);
        statePlayer.push(b); // after the push the player stands where the box was
        stateParent.push(head);
        if (solved(next!)) found = statePlayer.length - 1;
      }
    }
    for (const x of boxes) blocked[x] = 0;
  }
  if (found < 0) return null;

  // Rebuild the moves: walk to each push's stand square, then push, state by state.
  const chain: number[] = [];
  for (let s = found; s > 0; s = stateParent[s]) chain.push(s);
  chain.reverse();
  let moves = '';
  let player = board.player;
  let boxes = board.boxes;
  for (const s of chain) {
    const nextBoxes = flat.slice(s * n, s * n + n);
    const from = boxes.find((b) => !nextBoxes.includes(b))!;
    const to = nextBoxes.find((b) => !boxes.includes(b))!;
    const d = to - from;
    const dir = DIRS.find(({ dx, dy }) => dy * w + dx === d)!;
    for (const b of boxes) blocked[b] = 1;
    moves += walkPath(w, wall, blocked, player, from - d);
    for (const b of boxes) blocked[b] = 0;
    moves += dir.push;
    player = from;
    boxes = nextBoxes;
  }
  return { pushes: chain.length, moves };
}

/**
 * The level's rooms: cut the dead squares of the player's row (the hallway: a box there reaches
 * no goal) out of the floor; each part left that holds boxes is a room, with its own goals. Null
 * when the level is no such set of rooms (a box in the hallway, or a part whose boxes and goals
 * do not balance).
 */
function roomsOf(level: Board): { boxes: number[]; goals: number[] }[] | null {
  const { w, size, wall, goals, boxes, player } = level;
  const live = liveSquares(w, wall, goals);
  const rowStart = Math.floor(player / w) * w;
  const cut = new Uint8Array(size);
  for (let i = rowStart; i < rowStart + w; i++) if (!wall[i] && !live[i]) cut[i] = 1;
  if (boxes.some((b) => cut[b] === 1)) return null;
  const part = new Int32Array(size).fill(-1);
  const parts: { squares: number[]; boxes: number[]; goals: number[] }[] = [];
  for (let s = 0; s < size; s++) {
    if (wall[s] || cut[s] || part[s] >= 0) continue;
    const id = parts.length;
    const squares = [s];
    part[s] = id;
    for (let i = 0; i < squares.length; i++) {
      for (const { dx, dy } of DIRS) {
        const q = squares[i] + dy * w + dx;
        if (q < 0 || q >= size || wall[q] || cut[q] || part[q] >= 0) continue;
        part[q] = id;
        squares.push(q);
      }
    }
    parts.push({ squares, boxes: [], goals: [] });
  }
  for (const b of boxes) parts[part[b]].boxes.push(b);
  for (const g of goals) {
    if (part[g] < 0) return null;
    parts[part[g]].goals.push(g);
  }
  if (parts.some((p) => p.boxes.length !== p.goals.length)) return null;
  return parts
    .filter((p) => p.boxes.length > 0)
    .map((p) => ({ boxes: p.boxes.slice().sort((a, b) => a - b), goals: p.goals.slice().sort((a, b) => a - b) }));
}

/** Where the player stands after playing `moves` from `from` (every letter steps one square). */
function endSquare(w: number, from: number, moves: string): number {
  let p = from;
  for (const ch of moves) {
    const c = ch.toLowerCase();
    p += c === 'u' ? -w : c === 'd' ? w : c === 'l' ? -1 : 1;
  }
  return p;
}

/** A level's answer: each room solved in turn, the other rooms' boxes standing as walls. */
function solveLevel(text: string): string {
  const level = parseLevel(text);
  const rooms = roomsOf(level) ?? [{ boxes: level.boxes, goals: level.goals }];
  let player = level.player;
  let moves = '';
  for (const room of rooms) {
    const wall = level.wall.slice();
    for (const other of rooms) {
      if (other === room) continue;
      for (const b of other.boxes) wall[b] = 1;
    }
    const sub: Board = { w: level.w, size: level.size, wall, goals: room.goals, boxes: room.boxes, player };
    const solvedRoom = solveRoom(sub);
    if (solvedRoom === null) return '';
    moves += solvedRoom.moves;
    player = endSquare(level.w, player, solvedRoom.moves);
    room.boxes = room.goals; // the room's boxes now stand on its goals, walls to the next room
  }
  return moves;
}

for (const id of readdirSync(IN_DIR).sort()) {
  const moves = solveLevel(readFileSync(join(IN_DIR, id, 'level.txt'), 'utf8'));
  mkdirSync(join(OUT_DIR, id), { recursive: true });
  writeFileSync(join(OUT_DIR, id, 'solution.txt'), `${moves}\n`);
}
