import express from "express";
import { randomUUID } from "node:crypto";

const app = express();
const PORT = Number(process.env.PORT || 10000);

app.use(express.json());
app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (origin) res.header("Access-Control-Allow-Origin", origin);
  res.header("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.header("Access-Control-Allow-Headers", "Origin, X-Requested-With, Content-Type, Accept, Authorization");
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

const queue = new Map();
const matches = new Map();

function normalizeScramble(value) {
  return String(value ?? "").trim().replace(/\s+/g, " ");
}

function generateScramble(length = 20) {
  const faces = ["R", "L", "U", "D", "F", "B"];
  const suffixes = ["", "'", "2"];
  const result = [];
  let lastFace = "";
  while (result.length < length) {
    const face = faces[Math.floor(Math.random() * faces.length)];
    if (face === lastFace) continue;
    result.push(face + suffixes[Math.floor(Math.random() * suffixes.length)]);
    lastFace = face;
  }
  return result.join(" ");
}

function findActiveMatchByPlayerId(playerId) {
  for (const match of matches.values()) {
    if (match.phase !== "finished" && match.players.some((p) => p.id === playerId)) return match;
  }
  return undefined;
}

function advanceMatch(match) {
  if (match.phase === "ready" && match.raceStartAt !== null && Date.now() >= match.raceStartAt) {
    match.phase = "racing";
    for (const player of match.players) {
      if (player.startedAt === null) player.startedAt = match.raceStartAt;
    }
  }
  return match;
}

function snapshot(match) {
  advanceMatch(match);
  return {
    ...match,
    players: match.players.map((p) => ({ ...p }))
  };
}

function getMatch(req) {
  const id = String(req.body?.matchId ?? req.query.matchId ?? "");
  return matches.get(id);
}

app.get("/api/health", (_req, res) => {
  res.json({ ok: true, service: "cubepulse-matchmaking", timestamp: Date.now() });
});

app.post("/api/matchmaking/join", (req, res) => {
  const playerId = String(req.body?.playerId || randomUUID());
  const existing = findActiveMatchByPlayerId(playerId);
  if (existing) return res.json({ status: "matched", playerId, match: snapshot(existing) });

  const requested = normalizeScramble(req.body?.scramble);
  const scramble = requested || generateScramble();

  for (const [key, entry] of queue) {
    if (entry.playerId === playerId) queue.delete(key);
  }

  const opponent = [...queue.entries()].find(([, entry]) => entry.playerId !== playerId);
  if (!opponent) {
    queue.set(playerId, { playerId, scramble });
    return res.json({ status: "searching", playerId });
  }

  queue.delete(opponent[0]);
  const match = {
    id: randomUUID(),
    scramble: opponent[1].scramble || scramble,
    players: [
      { id: opponent[1].playerId, ready: false, startedAt: null, solvedAt: null, solveTimeMs: null },
      { id: playerId, ready: false, startedAt: null, solvedAt: null, solveTimeMs: null }
    ],
    phase: "ready",
    raceStartAt: null,
    firstSolverId: null,
    deadlineAt: null,
    winnerId: null,
    loserId: null
  };
  matches.set(match.id, match);
  return res.json({ status: "matched", playerId, match: snapshot(match) });
});

app.get("/api/matchmaking/state", (req, res) => {
  const match = getMatch(req);
  if (!match) return res.status(404).json({ error: "match not found" });
  res.json(snapshot(match));
});

app.post("/api/matchmaking/ready", (req, res) => {
  const match = getMatch(req);
  const player = match?.players.find((p) => p.id === String(req.body?.playerId || ""));
  if (!match || !player) return res.status(404).json({ error: "match/player not found" });
  player.ready = true;
  res.json(snapshot(match));
});

app.post("/api/matchmaking/start", (req, res) => {
  const match = getMatch(req);
  const player = match?.players.find((p) => p.id === String(req.body?.playerId || ""));
  if (!match || !player) return res.status(404).json({ error: "match/player not found" });
  if (!match.players.every((p) => p.ready)) return res.status(409).json({ error: "both players must be ready" });
  if (match.raceStartAt === null) match.raceStartAt = Date.now() + 3000;
  res.json(snapshot(match));
});

app.post("/api/matchmaking/solve", (req, res) => {
  const match = getMatch(req);
  const player = match?.players.find((p) => p.id === String(req.body?.playerId || ""));
  if (!match || !player) return res.status(404).json({ error: "match/player not found" });

  advanceMatch(match);
  if (match.phase !== "racing") return res.json(snapshot(match));
  if (player.solvedAt !== null) return res.json(snapshot(match));

  const now = Date.now();
  const requestedSolvedAt = Number(req.body?.solvedAt);
  const requestedElapsedMs = Number(req.body?.elapsedMs);
  const acceptedSolvedAt = Math.min(Number.isFinite(requestedSolvedAt) ? requestedSolvedAt : now, now);
  const startAt = player.startedAt ?? match.raceStartAt ?? now;
  const calculated = Math.max(1, acceptedSolvedAt - startAt);
  const clientElapsed = Number.isFinite(requestedElapsedMs) && requestedElapsedMs > 0 ? Math.round(requestedElapsedMs) : 0;
  const solveTimeMs = Math.max(1, clientElapsed > 0 ? clientElapsed : calculated);

  if (match.deadlineAt !== null && match.firstSolverId !== player.id && acceptedSolvedAt > match.deadlineAt) {
    const first = match.players.find((p) => p.id === match.firstSolverId);
    match.phase = "finished";
    match.winnerId = first?.id ?? null;
    match.loserId = player.id;
    return res.json(snapshot(match));
  }

  player.startedAt = startAt;
  player.solvedAt = acceptedSolvedAt;
  player.solveTimeMs = solveTimeMs;

  if (match.firstSolverId === null) {
    match.firstSolverId = player.id;
    match.deadlineAt = acceptedSolvedAt + 15000;
    return res.json(snapshot(match));
  }

  const first = match.players.find((p) => p.id === match.firstSolverId);
  if (!first || first.solveTimeMs == null) return res.status(409).json({ error: "first solver state is incomplete" });

  const firstTime = first.solveTimeMs;
  const secondTime = player.solveTimeMs;
  match.phase = "finished";
  match.winnerId = secondTime < firstTime ? player.id : first.id;
  match.loserId = secondTime < firstTime ? first.id : player.id;
  res.json(snapshot(match));
});

app.post("/api/matchmaking/timeout", (req, res) => {
  const match = getMatch(req);
  if (!match) return res.status(404).json({ error: "match not found" });
  advanceMatch(match);
  if (match.phase === "finished") return res.json(snapshot(match));
  if (match.phase !== "racing" || !match.firstSolverId || !match.deadlineAt) return res.json(snapshot(match));

  if (Date.now() < match.deadlineAt) return res.json(snapshot(match));

  const first = match.players.find((p) => p.id === match.firstSolverId);
  const second = match.players.find((p) => p.id !== match.firstSolverId);
  if (second?.solvedAt !== null) {
    const firstTime = first?.solveTimeMs ?? Number.POSITIVE_INFINITY;
    const secondTime = second?.solveTimeMs ?? Number.POSITIVE_INFINITY;
    match.phase = "finished";
    if (second) {
      match.winnerId = secondTime < firstTime ? second.id : first?.id ?? null;
      match.loserId = secondTime < firstTime ? first?.id ?? null : second.id;
    }
    return res.json(snapshot(match));
  }

  match.phase = "finished";
  match.winnerId = first?.id ?? null;
  match.loserId = second?.id ?? null;
  res.json(snapshot(match));
});

app.post("/api/matchmaking/leave", (req, res) => {
  queue.delete(String(req.body?.playerId || ""));
  res.json({ ok: true });
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`[api] CubePulse public server listening on ${PORT}`);
});
