import express from "express";
import { randomUUID } from "node:crypto";

const app = express();
const PORT = Number(process.env.PORT || 10000);

app.use(express.json());

app.use((req, res, next) => {
  const origin = req.headers.origin;

  if (origin) {
    res.header("Access-Control-Allow-Origin", origin);
  }

  res.header(
    "Access-Control-Allow-Methods",
    "GET, POST, OPTIONS"
  );

  res.header(
    "Access-Control-Allow-Headers",
    "Origin, X-Requested-With, Content-Type, Accept, Authorization"
  );

  if (req.method === "OPTIONS") {
    return res.sendStatus(204);
  }

  next();
});

const queue = new Map();
const matches = new Map();

function normalizeScramble(value) {
  return String(value ?? "")
    .trim()
    .replace(/\s+/g, " ");
}

function normalizeUsername(value) {
  const username = String(value ?? "")
    .trim()
    .replace(/\s+/g, " ");

  return username.slice(0, 20) || "Player";
}

function generateScramble(length = 20) {
  const faces = ["R", "L", "U", "D", "F", "B"];
  const suffixes = ["", "'", "2"];

  const result = [];
  let lastFace = "";

  while (result.length < length) {
    const face =
      faces[Math.floor(Math.random() * faces.length)];

    if (face === lastFace) {
      continue;
    }

    result.push(
      face +
        suffixes[
          Math.floor(Math.random() * suffixes.length)
        ]
    );

    lastFace = face;
  }

  return result.join(" ");
}

function findActiveMatchByPlayerId(playerId) {
  for (const match of matches.values()) {
    if (
      match.phase !== "finished" &&
      match.players.some((p) => p.id === playerId)
    ) {
      return match;
    }
  }

  return undefined;
}

function advanceMatch(match) {
  if (
    match.phase === "ready" &&
    match.raceStartAt !== null &&
    Date.now() >= match.raceStartAt
  ) {
    match.phase = "racing";

    for (const player of match.players) {
      if (player.startedAt === null) {
        player.startedAt = match.raceStartAt;
      }
    }
  }

  return match;
}

function snapshot(match) {
  advanceMatch(match);

  return {
    ...match,
    players: match.players.map((p) => ({
      ...p,
    })),
  };
}

function getMatch(req) {
  const id = String(
    req.body?.matchId ??
      req.query.matchId ??
      ""
  );

  return matches.get(id);
}

app.get("/api/health", (_req, res) => {
  res.json({
    ok: true,
    service: "cubepulse-matchmaking",
    timestamp: Date.now(),
  });
});

/*
|--------------------------------------------------------------------------
| DEBUG
|--------------------------------------------------------------------------
*/

app.get("/api/matchmaking/debug", (_req, res) => {
  res.json({
    ok: true,

    queuedPlayers: [...queue.values()].map(
      (entry) => ({
        playerId: entry.playerId,
        username: entry.username,
      })
    ),

    activeMatches: [...matches.values()].map(
      (match) => ({
        id: match.id,
        phase: match.phase,

        players: match.players.map(
          (player) => ({
            id: player.id,
            username: player.username,
            ready: player.ready,
          })
        ),
      })
    ),
  });
});

/*
|--------------------------------------------------------------------------
| JOIN / MATCHMAKING
|--------------------------------------------------------------------------
*/

app.post("/api/matchmaking/join", (req, res) => {
  const playerId = String(
    req.body?.playerId ||
      randomUUID()
  );

  const username = normalizeUsername(
    req.body?.username
  );

  console.log(
    `[matchmaking] join player=${playerId} username="${username}"`
  );

  /*
   * Check if player is already inside
   * an active match.
   */
  const existing =
    findActiveMatchByPlayerId(playerId);

  if (existing) {
    const me =
      existing.players.find(
        (p) => p.id === playerId
      );

    /*
     * Always refresh the player's
     * username when they reconnect.
     */
    if (me) {
      me.username = username;
    }

    return res.json({
      status: "matched",
      playerId,
      match: snapshot(existing),
    });
  }

  /*
   * Scramble supplied by client.
   * If missing, generate one.
   */
  const requested =
    normalizeScramble(
      req.body?.scramble
    );

  const scramble =
    requested ||
    generateScramble();

  /*
   * Remove duplicate queue entry
   * for same player.
   */
  for (const [key, entry] of queue) {
    if (entry.playerId === playerId) {
      queue.delete(key);
    }
  }

  /*
   * Find another player waiting.
   */
  const opponent =
    [...queue.entries()].find(
      ([, entry]) =>
        entry.playerId !== playerId
    );

  /*
   * Nobody found yet.
   */
  if (!opponent) {
    queue.set(playerId, {
      playerId,
      username,
      scramble,
    });

    return res.json({
      status: "searching",
      playerId,
    });
  }

  /*
   * Opponent found.
   */
  queue.delete(opponent[0]);

  const match = {
    id: randomUUID(),

    scramble:
      opponent[1].scramble ||
      scramble,

    players: [
      {
        id: opponent[1].playerId,
        username: opponent[1].username,
        ready: false,
        startedAt: null,
        solvedAt: null,
        solveTimeMs: null,
      },

      {
        id: playerId,
        username,
        ready: false,
        startedAt: null,
        solvedAt: null,
        solveTimeMs: null,
      },
    ],

    phase: "ready",

    raceStartAt: null,

    firstSolverId: null,

    deadlineAt: null,

    winnerId: null,

    loserId: null,
  };

  matches.set(
    match.id,
    match
  );

  console.log(
    `[matchmaking] matched ${match.players[0].username} vs ${match.players[1].username} match=${match.id}`
  );

  return res.json({
    status: "matched",
    playerId,
    match: snapshot(match),
  });
});

/*
|--------------------------------------------------------------------------
| MATCH STATE
|--------------------------------------------------------------------------
*/

app.get("/api/matchmaking/state", (req, res) => {
  const match = getMatch(req);

  if (!match) {
    return res
      .status(404)
      .json({
        error: "match not found",
      });
  }

  res.json(
    snapshot(match)
  );
});

/*
|--------------------------------------------------------------------------
| READY
|--------------------------------------------------------------------------
*/

app.post("/api/matchmaking/ready", (req, res) => {
  const match = getMatch(req);

  const player =
    match?.players.find(
      (p) =>
        p.id ===
        String(
          req.body?.playerId ||
            ""
        )
    );

  if (!match || !player) {
    return res
      .status(404)
      .json({
        error:
          "match/player not found",
      });
  }

  player.ready = true;

  res.json(
    snapshot(match)
  );
});

/*
|--------------------------------------------------------------------------
| START
|--------------------------------------------------------------------------
*/

app.post("/api/matchmaking/start", (req, res) => {
  const match = getMatch(req);

  const player =
    match?.players.find(
      (p) =>
        p.id ===
        String(
          req.body?.playerId ||
            ""
        )
    );

  if (!match || !player) {
    return res
      .status(404)
      .json({
        error:
          "match/player not found",
      });
  }

  if (
    !match.players.every(
      (p) => p.ready
    )
  ) {
    return res
      .status(409)
      .json({
        error:
          "both players must be ready",
      });
  }

  if (
    match.raceStartAt === null
  ) {
    match.raceStartAt =
      Date.now() + 3000;
  }

  res.json(
    snapshot(match)
  );
});

/*
|--------------------------------------------------------------------------
| SOLVE
|--------------------------------------------------------------------------
*/

app.post("/api/matchmaking/solve", (req, res) => {
  const match = getMatch(req);

  const player =
    match?.players.find(
      (p) =>
        p.id ===
        String(
          req.body?.playerId ||
            ""
        )
    );

  if (!match || !player) {
    return res
      .status(404)
      .json({
        error:
          "match/player not found",
      });
  }

  advanceMatch(match);

  if (
    match.phase !== "racing"
  ) {
    return res.json(
      snapshot(match)
    );
  }

  if (
    player.solvedAt !== null
  ) {
    return res.json(
      snapshot(match)
    );
  }

  const now = Date.now();

  const requestedSolvedAt =
    Number(
      req.body?.solvedAt
    );

  const requestedElapsedMs =
    Number(
      req.body?.elapsedMs
    );

  const acceptedSolvedAt =
    Math.min(
      Number.isFinite(
        requestedSolvedAt
      )
        ? requestedSolvedAt
        : now,
      now
    );

  const startAt =
    player.startedAt ??
    match.raceStartAt ??
    now;

  const calculated =
    Math.max(
      1,
      acceptedSolvedAt -
        startAt
    );

  const clientElapsed =
    Number.isFinite(
      requestedElapsedMs
    ) &&
    requestedElapsedMs > 0
      ? Math.round(
          requestedElapsedMs
        )
      : 0;

  const solveTimeMs =
    Math.max(
      1,
      clientElapsed > 0
        ? clientElapsed
        : calculated
    );

  /*
   * Finish window timeout.
   */
  if (
    match.deadlineAt !== null &&
    match.firstSolverId !==
      player.id &&
    acceptedSolvedAt >
      match.deadlineAt
  ) {
    const first =
      match.players.find(
        (p) =>
          p.id ===
          match.firstSolverId
      );

    match.phase =
      "finished";

    match.winnerId =
      first?.id ?? null;

    match.loserId =
      player.id;

    return res.json(
      snapshot(match)
    );
  }

  player.startedAt =
    startAt;

  player.solvedAt =
    acceptedSolvedAt;

  player.solveTimeMs =
    solveTimeMs;

  /*
   * First solver.
   */
  if (
    match.firstSolverId ===
    null
  ) {
    match.firstSolverId =
      player.id;

    match.deadlineAt =
      acceptedSolvedAt +
      15000;

    return res.json(
      snapshot(match)
    );
  }

  /*
   * Second solver.
   */
  const first =
    match.players.find(
      (p) =>
        p.id ===
        match.firstSolverId
    );

  if (
    !first ||
    first.solveTimeMs ==
      null
  ) {
    return res
      .status(409)
      .json({
        error:
          "first solver state is incomplete",
      });
  }

  const firstTime =
    first.solveTimeMs;

  const secondTime =
    player.solveTimeMs;

  match.phase =
    "finished";

  match.winnerId =
    secondTime < firstTime
      ? player.id
      : first.id;

  match.loserId =
    secondTime < firstTime
      ? first.id
      : player.id;

  res.json(
    snapshot(match)
  );
});

/*
|--------------------------------------------------------------------------
| TIMEOUT
|--------------------------------------------------------------------------
*/

app.post("/api/matchmaking/timeout", (req, res) => {
  const match =
    getMatch(req);

  if (!match) {
    return res
      .status(404)
      .json({
        error:
          "match not found",
      });
  }

  advanceMatch(match);

  if (
    match.phase ===
    "finished"
  ) {
    return res.json(
      snapshot(match)
    );
  }

  if (
    match.phase !==
      "racing" ||
    !match.firstSolverId ||
    !match.deadlineAt
  ) {
    return res.json(
      snapshot(match)
    );
  }

  if (
    Date.now() <
    match.deadlineAt
  ) {
    return res.json(
      snapshot(match)
    );
  }

  const first =
    match.players.find(
      (p) =>
        p.id ===
        match.firstSolverId
    );

  const second =
    match.players.find(
      (p) =>
        p.id !==
        match.firstSolverId
    );

  /*
   * Both solved.
   */
  if (
    second?.solvedAt !==
    null
  ) {
    const firstTime =
      first?.solveTimeMs ??
      Number.POSITIVE_INFINITY;

    const secondTime =
      second?.solveTimeMs ??
      Number.POSITIVE_INFINITY;

    match.phase =
      "finished";

    if (second) {
      match.winnerId =
        secondTime <
        firstTime
          ? second.id
          : first?.id ??
            null;

      match.loserId =
        secondTime <
        firstTime
          ? first?.id ??
            null
          : second.id;
    }

    return res.json(
      snapshot(match)
    );
  }

  /*
   * Only first player solved.
   */
  match.phase =
    "finished";

  match.winnerId =
    first?.id ?? null;

  match.loserId =
    second?.id ?? null;

  res.json(
    snapshot(match)
  );
});

/*
|--------------------------------------------------------------------------
| LEAVE QUEUE
|--------------------------------------------------------------------------
*/

app.post("/api/matchmaking/leave", (req, res) => {
  queue.delete(
    String(
      req.body?.playerId ||
        ""
    )
  );

  res.json({
    ok: true,
  });
});

/*
|--------------------------------------------------------------------------
| START SERVER
|--------------------------------------------------------------------------
*/

app.listen(
  PORT,
  "0.0.0.0",
  () => {
    console.log(
      `[api] CubePulse public server listening on ${PORT}`
    );
  }
);