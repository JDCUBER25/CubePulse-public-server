const express = require("express");
const { randomUUID } = require("crypto");

const app = express();
const PORT = Number(process.env.PORT || 10000);

app.use(express.json());

// =============================================================================
// CORS
// =============================================================================

app.use((req, res, next) => {
  const origin = req.headers.origin;

  if (origin) {
    res.header(
      "Access-Control-Allow-Origin",
      origin
    );
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

// =============================================================================
// HELPERS
// =============================================================================

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
      faces[
        Math.floor(
          Math.random() * faces.length
        )
      ];

    if (face === lastFace) {
      continue;
    }

    const suffix =
      suffixes[
        Math.floor(
          Math.random() * suffixes.length
        )
      ];

    result.push(face + suffix);
    lastFace = face;
  }

  return result.join(" ");
}

// =============================================================================
// 1v1 BATTLE
// =============================================================================

const queue = new Map();
const matches = new Map();

function findActiveMatchByPlayerId(
  playerId,
  store = matches
) {
  for (const match of store.values()) {
    if (
      match.phase !== "finished" &&
      match.players.some(
        (player) =>
          player.id === playerId
      )
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
    players: match.players.map(
      (player) => ({
        ...player,
      })
    ),
  };
}

function getMatch(req) {
  const id = String(
    req.body?.matchId ??
      req.query?.matchId ??
      ""
  );

  return matches.get(id);
}

// =============================================================================
// HEALTH
// =============================================================================

app.get("/api/health", (_req, res) => {
  res.json({
    ok: true,
    service: "cubepulse-matchmaking",
    timestamp: Date.now(),
  });
});

// =============================================================================
// 1v1 DEBUG
// =============================================================================

app.get(
  "/api/matchmaking/debug",
  (_req, res) => {
    res.json({
      ok: true,

      queuedPlayers: [
        ...queue.values(),
      ].map((entry) => ({
        playerId: entry.playerId,
        username: entry.username,
      })),

      activeMatches: [
        ...matches.values(),
      ].map((match) => ({
        id: match.id,
        phase: match.phase,
        players: match.players.map(
          (player) => ({
            id: player.id,
            username: player.username,
            ready: player.ready,
          })
        ),
      })),
    });
  }
);

// =============================================================================
// 1v1 JOIN
// =============================================================================

app.post(
  "/api/matchmaking/join",
  (req, res) => {
    const playerId = String(
      req.body?.playerId ||
        randomUUID()
    );

    const username =
      normalizeUsername(
        req.body?.username
      );

    const existing =
      findActiveMatchByPlayerId(
        playerId,
        matches
      );

    if (existing) {
      const me =
        existing.players.find(
          (player) =>
            player.id === playerId
        );

      if (me) {
        me.username = username;
      }

      return res.json({
        status: "matched",
        playerId,
        match: snapshot(existing),
      });
    }

    const requested =
      normalizeScramble(
        req.body?.scramble
      );

    const scramble =
      requested ||
      generateScramble();

    for (
      const [key, entry] of queue
    ) {
      if (
        entry.playerId === playerId
      ) {
        queue.delete(key);
      }
    }

    const opponent =
      [...queue.entries()].find(
        ([, entry]) =>
          entry.playerId !== playerId
      );

    if (!opponent) {
      queue.set(
        playerId,
        {
          playerId,
          username,
          scramble,
        }
      );

      return res.json({
        status: "searching",
        playerId,
      });
    }

    queue.delete(opponent[0]);

    const match = {
      id: randomUUID(),

      scramble:
        opponent[1].scramble ||
        scramble,

      phase: "ready",

      raceStartAt: null,

      firstSolverId: null,

      deadlineAt: null,

      winnerId: null,

      loserId: null,

      players: [
        {
          id:
            opponent[1].playerId,

          username:
            opponent[1].username,

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
    };

    matches.set(
      match.id,
      match
    );

    return res.json({
      status: "matched",
      playerId,
      match: snapshot(match),
    });
  }
);

// =============================================================================
// 1v1 STATE
// =============================================================================

app.get(
  "/api/matchmaking/state",
  (req, res) => {
    const match = getMatch(req);

    if (!match) {
      return res.status(404).json({
        error: "match not found",
      });
    }

    return res.json(
      snapshot(match)
    );
  }
);

// =============================================================================
// 1v1 READY
// =============================================================================

app.post(
  "/api/matchmaking/ready",
  (req, res) => {
    const match = getMatch(req);

    const playerId = String(
      req.body?.playerId || ""
    );

    const player =
      match?.players.find(
        (p) =>
          p.id === playerId
      );

    if (!match || !player) {
      return res.status(404).json({
        error:
          "match/player not found",
      });
    }

    player.ready = true;

    return res.json(
      snapshot(match)
    );
  }
);

// =============================================================================
// 1v1 START
// =============================================================================

app.post(
  "/api/matchmaking/start",
  (req, res) => {
    const match = getMatch(req);

    const playerId = String(
      req.body?.playerId || ""
    );

    const player =
      match?.players.find(
        (p) =>
          p.id === playerId
      );

    if (!match || !player) {
      return res.status(404).json({
        error:
          "match/player not found",
      });
    }

    if (
      !match.players.every(
        (p) => p.ready
      )
    ) {
      return res.status(409).json({
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

    return res.json(
      snapshot(match)
    );
  }
);

// =============================================================================
// 1v1 SOLVE
// =============================================================================

app.post(
  "/api/matchmaking/solve",
  (req, res) => {
    const match = getMatch(req);

    const playerId = String(
      req.body?.playerId || ""
    );

    const player =
      match?.players.find(
        (p) =>
          p.id === playerId
      );

    if (!match || !player) {
      return res.status(404).json({
        error:
          "match/player not found",
      });
    }

    advanceMatch(match);

    if (
      match.phase !== "racing" ||
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
        first?.id ??
        null;

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

    if (
      match.firstSolverId ===
      null
    ) {
      match.firstSolverId =
        player.id;

      match.deadlineAt =
        acceptedSolvedAt + 15000;

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

    if (
      !first ||
      first.solveTimeMs === null
    ) {
      return res.status(409).json({
        error:
          "first solver state is incomplete",
      });
    }

    const secondTime =
      player.solveTimeMs;

    const firstTime =
      first.solveTimeMs;

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

    return res.json(
      snapshot(match)
    );
  }
);

// =============================================================================
// 1v1 TIMEOUT
// =============================================================================

app.post(
  "/api/matchmaking/timeout",
  (req, res) => {
    const match = getMatch(req);

    const playerId = String(
      req.body?.playerId || ""
    );

    if (!match) {
      return res.status(404).json({
        error:
          "match not found",
      });
    }

    if (
      !match.players.some(
        (p) =>
          p.id === playerId
      )
    ) {
      return res.status(403).json({
        error:
          "player is not part of this match",
      });
    }

    advanceMatch(match);

    if (
      match.phase === "finished"
    ) {
      return res.json(
        snapshot(match)
      );
    }

    if (
      match.phase !== "racing" ||
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

    if (
      second?.solvedAt !== null
    ) {
      const firstTime =
        first?.solveTimeMs ??
        Number.POSITIVE_INFINITY;

      const secondTime =
        second?.solveTimeMs ??
        Number.POSITIVE_INFINITY;

      match.phase =
        "finished";

      match.winnerId =
        secondTime < firstTime
          ? second.id
          : first?.id ?? null;

      match.loserId =
        secondTime < firstTime
          ? first?.id ?? null
          : second.id;

      return res.json(
        snapshot(match)
      );
    }

    match.phase =
      "finished";

    match.winnerId =
      first?.id ?? null;

    match.loserId =
      second?.id ?? null;

    return res.json(
      snapshot(match)
    );
  }
);

// =============================================================================
// 1v1 LEAVE
// =============================================================================

app.post(
  "/api/matchmaking/leave",
  (req, res) => {
    queue.delete(
      String(
        req.body?.playerId || ""
      )
    );

    return res.json({
      ok: true,
    });
  }
);

// =============================================================================
// TWIST LEAGUE
// =============================================================================

const twistLeagueQueue =
  new Map();

const twistLeagueMatches =
  new Map();

const twistLeagueTournaments =
  new Map();

const TWIST_QUEUE_TTL_MS =
  15000;

const TWIST_PLAYER_CAPACITY =
  4;

const TWIST_SERIES_WINS =
  3;

const TWIST_FINISH_WINDOW_MS =
  15000;

const TWIST_START_DELAY_MS =
  3000;

// 90-second ready window.
const TWIST_READY_TIMEOUT_MS =
  90_000;

// Heartbeat every second.
const TWIST_HEARTBEAT_INTERVAL_MS =
  1000;

// A temporary network loss may reconnect within this window.
const TWIST_DISCONNECT_TIMEOUT_MS =
  12_000;

// =============================================================================
// QUEUE CLEANUP
// =============================================================================

function cleanupTwistLeagueQueue() {
  const now =
    Date.now();

  for (
    const [
      key,
      entry,
    ] of twistLeagueQueue
  ) {
    if (
      !entry.joinedAt ||
      now -
        entry.joinedAt >
        TWIST_QUEUE_TTL_MS
    ) {
      twistLeagueQueue.delete(
        key
      );
    }
  }
}

// =============================================================================
// FINISHED CHECK
// =============================================================================

function isTwistTournamentFinished(
  tournament
) {
  if (!tournament) {
    return false;
  }

  if (
    tournament.phase ===
    "finished"
  ) {
    return true;
  }

  if (
    tournament.championId
  ) {
    return true;
  }

  if (
    tournament.finalMatchId
  ) {
    const finalMatch =
      twistLeagueMatches.get(
        tournament.finalMatchId
      );

    if (
      finalMatch &&
      finalMatch.phase ===
        "finished" &&
      finalMatch.seriesWinnerId
    ) {
      return true;
    }
  }

  return false;
}

// =============================================================================
// ACTIVE TOURNAMENT BY PLAYER
// =============================================================================

function findActiveTwistTournamentByPlayerId(
  playerId
) {
  for (
    const tournament of
      twistLeagueTournaments.values()
  ) {
    if (
      isTwistTournamentFinished(
        tournament
      )
    ) {
      continue;
    }

    if (
      tournament.players.some(
        (player) =>
          player.id === playerId
      )
    ) {
      return tournament;
    }
  }

  return undefined;
}

// =============================================================================
// ACTIVE MATCH BY PLAYER
// =============================================================================

function findActiveTwistMatchByPlayerId(
  playerId
) {
  for (
    const match of
      twistLeagueMatches.values()
  ) {
    if (
      match.phase !== "finished" &&
      match.players.some(
        (player) =>
          player.id === playerId
      )
    ) {
      return match;
    }
  }

  return undefined;
}

// =============================================================================
// ANY TOURNAMENT BY PLAYER
// =============================================================================

function findTwistTournamentByPlayerId(
  playerId
) {
  for (
    const tournament of
      twistLeagueTournaments.values()
  ) {
    const player =
      tournament.players.find(
        (p) =>
          p.id === playerId
      );

    if (player) {
      return tournament;
    }
  }

  return undefined;
}

// =============================================================================
// CREATE PLAYER
// =============================================================================

function createTwistPlayer(
  id,
  username,
  seed
) {
  return {
    id,
    username,
    seed,

    semFinalMatchId:
      null,

    finalMatchId:
      null,

    status:
      "waiting",

    eliminated:
      false,

    lastSeenAt:
      Date.now(),
  };
}

// =============================================================================
// CREATE MATCH
// =============================================================================

function createTwistMatch({
  tournamentId,
  stage,
  slot,
  players,
}) {
  const seriesWins =
    {};

  for (
    const player of players
  ) {
    seriesWins[
      player.id
    ] = 0;
  }

  return {
    id:
      randomUUID(),

    tournamentId,

    stage,

    slot,

    format:
      "BO3",

    capacity:
      2,

    phase:
      "ready",

    scramble:
      generateScramble(),

    raceStartAt:
      null,

    readyDeadlineAt:
      Date.now() +
      TWIST_READY_TIMEOUT_MS,

    firstSolverId:
      null,

    deadlineAt:
      null,

    winnerId:
      null,

    loserId:
      null,

    seriesWins,

    gameNumber:
      1,

    seriesWinnerId:
      null,

    forfeit:
      false,

    forfeitedPlayerId:
      null,

    lastGameResult:
      null,

    players:
      players.map(
        (player) => ({
          id:
            player.id,

          username:
            player.username,

          ready:
            false,

          startedAt:
            null,

          solvedAt:
            null,

          solveTimeMs:
            null,

          lastSeenAt:
            player.lastSeenAt ??
            Date.now(),
        })
      ),
  };
}

// =============================================================================
// PREPARE NEXT GAME
// =============================================================================

function prepareNextTwistGame(
  match
) {
  match.gameNumber += 1;

  match.scramble =
    generateScramble();

  match.phase =
    "ready";

  match.raceStartAt =
    null;

  match.readyDeadlineAt =
    Date.now() +
    TWIST_READY_TIMEOUT_MS;

  match.firstSolverId =
    null;

  match.deadlineAt =
    null;

  match.winnerId =
    null;

  match.loserId =
    null;

  match.forfeit =
    false;

  match.forfeitedPlayerId =
    null;

  match.lastGameResult =
    null;

  for (
    const player of match.players
  ) {
    player.ready =
      false;

    player.startedAt =
      null;

    player.solvedAt =
      null;

    player.solveTimeMs =
      null;

    player.lastSeenAt =
      Date.now();
  }

  return match;
}

// =============================================================================
// BRACKET SNAPSHOT
// =============================================================================

function getTwistTournamentBracket(
  tournament
) {
  const finalMatch =
    tournament.finalMatchId
      ? twistLeagueMatches.get(
          tournament.finalMatchId
        )
      : null;

  return {
    tournamentId:
      tournament.id,

    capacity:
      TWIST_PLAYER_CAPACITY,

    joinedPlayers:
      tournament.players.length,

    totalPlayers:
      TWIST_PLAYER_CAPACITY,

    phase:
      tournament.phase,

    championId:
      tournament.championId,

    championName:
      isTwistTournamentFinished(
        tournament
      ) &&
      tournament.championId
        ? tournament.players.find(
            (player) =>
              player.id ===
              tournament.championId
          )?.username ??
          null
        : null,

    slots:
      tournament.players.map(
        (player) => ({
          seed:
            player.seed,

          id:
            player.id,

          username:
            player.username,

          status:
            player.status,

          eliminated:
            player.eliminated,

          semifinalMatchId:
            player.semFinalMatchId,

          finalMatchId:
            player.finalMatchId,
        })
      ),

    semifinals:
      tournament.semifinals.map(
        (semi) => {
          const semiMatch =
            semi.matchId
              ? twistLeagueMatches.get(
                  semi.matchId
                )
              : null;

          return {
            slot:
              semi.slot,

            matchId:
              semi.matchId,

            playerIds: [
              ...semi.playerIds,
            ],

            winnerId:
              semi.winnerId,

            complete:
              semi.complete,

            match:
              semiMatch
                ? {
                    matchId:
                      semiMatch.id,

                    stage:
                      semiMatch.stage,

                    slot:
                      semiMatch.slot,

                    phase:
                      semiMatch.phase,

                    gameNumber:
                      semiMatch.gameNumber,

                    readyDeadlineAt:
                      semiMatch.readyDeadlineAt ??
                      null,

                    seriesWins: {
                      ...(
                        semiMatch.seriesWins ??
                        {}
                      ),
                    },

                    seriesWinnerId:
                      semiMatch.seriesWinnerId ??
                      null,

                    winnerId:
                      semiMatch.winnerId ??
                      null,

                    players:
                      semiMatch.players.map(
                        (player) => ({
                          id:
                            player.id,

                          username:
                            player.username,

                          solvedAt:
                            player.solvedAt,

                          solveTimeMs:
                            player.solveTimeMs,

                          ready:
                            player.ready,
                        })
                      ),

                    lastGameResult:
                      semiMatch.lastGameResult ??
                      null,
                  }
                : null,
          };
        }
      ),

    final: {
      matchId:
        tournament.finalMatchId,

      playerIds: [
        ...tournament.finalPlayerIds,
      ],

      winnerId:
        tournament.phase ===
        "finished"
          ? tournament.championId
          : null,

      complete:
        tournament.phase ===
        "finished",

      match:
        finalMatch
          ? {
              matchId:
                finalMatch.id,

              stage:
                finalMatch.stage,

              slot:
                finalMatch.slot,

              phase:
                finalMatch.phase,

              gameNumber:
                finalMatch.gameNumber,

              readyDeadlineAt:
                finalMatch.readyDeadlineAt ??
                null,

              seriesWins: {
                ...(
                  finalMatch.seriesWins ??
                  {}
                ),
              },

              seriesWinnerId:
                finalMatch.seriesWinnerId ??
                null,

              winnerId:
                finalMatch.winnerId ??
                null,

              players:
                finalMatch.players.map(
                  (player) => ({
                    id:
                      player.id,

                    username:
                      player.username,

                    solvedAt:
                      player.solvedAt,

                    solveTimeMs:
                      player.solveTimeMs,

                    ready:
                      player.ready,
                  })
                ),

              lastGameResult:
                finalMatch.lastGameResult ??
                null,
            }
          : null,
    },
  };
}

// =============================================================================
// MATCH CLOCK
// =============================================================================

function advanceTwistLeagueMatch(
  match
) {
  if (
    match.phase ===
      "ready" &&
    match.raceStartAt !==
      null &&
    Date.now() >=
      match.raceStartAt
  ) {
    match.phase =
      "racing";

    match.readyDeadlineAt =
      null;

    for (
      const player of match.players
    ) {
      if (
        player.startedAt ===
        null
      ) {
        player.startedAt =
          match.raceStartAt;
      }
    }
  }

  return match;
}

// =============================================================================
// TOURNAMENT FOR MATCH
// =============================================================================

function getTwistTournamentForMatch(
  match
) {
  return twistLeagueTournaments.get(
    match.tournamentId
  );
}

// =============================================================================
// COMPLETE SERIES
// =============================================================================

function completeTwistSeriesIfNeeded(
  match
) {
  const seriesWins =
    match.seriesWins ?? {};

  const winnerId =
    Object.entries(
      seriesWins
    ).find(
      ([, wins]) =>
        Number(wins) >=
        TWIST_SERIES_WINS
    )?.[0] ?? null;

  if (!winnerId) {
    return false;
  }

  const loserId =
    match.players.find(
      (player) =>
        player.id !== winnerId
    )?.id ?? null;

  match.seriesWinnerId =
    winnerId;

  match.winnerId =
    winnerId;

  match.loserId =
    loserId;

  match.phase =
    "finished";

  match.raceStartAt =
    null;

  match.readyDeadlineAt =
    null;

  match.deadlineAt =
    null;

  const tournament =
    getTwistTournamentForMatch(
      match
    );

  if (!tournament) {
    return true;
  }

  if (
    match.stage ===
    "semifinal"
  ) {
    promoteSemifinalWinner(
      tournament,
      match
    );

    return true;
  }

  if (
    match.stage ===
    "final"
  ) {
    tournament.championId =
      winnerId;

    tournament.phase =
      "finished";

    const winner =
      tournament.players.find(
        (player) =>
          player.id === winnerId
      );

    const loser =
      tournament.players.find(
        (player) =>
          player.id === loserId
      );

    if (winner) {
      winner.status =
        "champion";

      winner.eliminated =
        false;
    }

    if (loser) {
      loser.status =
        "final-loser";

      loser.eliminated =
        false;
    }
  }

  return true;
}

// =============================================================================
// CREATE TOURNAMENT
// =============================================================================

function assignSemifinalStatus(
  tournament,
  playerIds,
  matchId
) {
  for (
    const id of playerIds
  ) {
    const player =
      tournament.players.find(
        (p) =>
          p.id === id
      );

    if (!player) {
      continue;
    }

    player.semFinalMatchId =
      matchId;

    player.status =
      "semifinal";

    player.eliminated =
      false;
  }
}

function createFourPlayerTwistTournament(
  entries
) {
  const players =
    entries.map(
      (
        entry,
        index
      ) =>
        createTwistPlayer(
          entry.playerId,
          entry.username,
          index + 1
        )
    );

  const tournament = {
    id:
      randomUUID(),

    capacity:
      TWIST_PLAYER_CAPACITY,

    phase:
      "semifinals",

    players,

    semifinals: [
      {
        slot:
          1,

        matchId:
          null,

        playerIds: [
          players[0].id,
          players[1].id,
        ],

        winnerId:
          null,

        complete:
          false,
      },

      {
        slot:
          2,

        matchId:
          null,

        playerIds: [
          players[2].id,
          players[3].id,
        ],

        winnerId:
          null,

        complete:
          false,
      },
    ],

    finalMatchId:
      null,

    finalPlayerIds:
      [],

    championId:
      null,
  };

  const semifinalA =
    createTwistMatch({
      tournamentId:
        tournament.id,

      stage:
        "semifinal",

      slot:
        1,

      players: [
        players[0],
        players[1],
      ],
    });

  const semifinalB =
    createTwistMatch({
      tournamentId:
        tournament.id,

      stage:
        "semifinal",

      slot:
        2,

      players: [
        players[2],
        players[3],
      ],
    });

  tournament.semifinals[0]
    .matchId =
    semifinalA.id;

  tournament.semifinals[1]
    .matchId =
    semifinalB.id;

  assignSemifinalStatus(
    tournament,
    tournament.semifinals[0]
      .playerIds,
    semifinalA.id
  );

  assignSemifinalStatus(
    tournament,
    tournament.semifinals[1]
      .playerIds,
    semifinalB.id
  );

  twistLeagueMatches.set(
    semifinalA.id,
    semifinalA
  );

  twistLeagueMatches.set(
    semifinalB.id,
    semifinalB
  );

  twistLeagueTournaments.set(
    tournament.id,
    tournament
  );

  return tournament;
}

// =============================================================================
// CREATE FINAL OR WALKOVER
// =============================================================================

function createFinalIfReady(
  tournament
) {
  if (
    tournament.phase !==
    "semifinals"
  ) {
    return;
  }

  if (
    !tournament.semifinals.every(
      (entry) =>
        entry.complete
    )
  ) {
    return;
  }

  const winners =
    tournament.semifinals
      .map(
        (entry) =>
          entry.winnerId
      )
      .filter(Boolean);

  // TWO WINNERS = REAL FINAL
  if (
    winners.length ===
    2
  ) {
    if (
      tournament.finalMatchId
    ) {
      return;
    }

    const finalPlayers =
      winners
        .map(
          (id) =>
            tournament.players.find(
              (player) =>
                player.id === id
            )
        )
        .filter(Boolean);

    if (
      finalPlayers.length !==
      2
    ) {
      return;
    }

    tournament.finalPlayerIds =
      finalPlayers.map(
        (player) =>
          player.id
      );

    tournament.phase =
      "final";

    const finalMatch =
      createTwistMatch({
        tournamentId:
          tournament.id,

        stage:
          "final",

        slot:
          1,

        players:
          finalPlayers,
      });

    tournament.finalMatchId =
      finalMatch.id;

    for (
      const player of finalPlayers
    ) {
      player.finalMatchId =
        finalMatch.id;

      player.status =
        "final";

      player.eliminated =
        false;
    }

    twistLeagueMatches.set(
      finalMatch.id,
      finalMatch
    );

    return;
  }

  // ONE WINNER = WALKOVER
  //
  // This only becomes champion when the other semifinal
  // finalist has explicitly LEFT.
  if (
    winners.length ===
    1
  ) {
    const onlyWinnerId =
      winners[0];

    const onlyWinner =
      tournament.players.find(
        (player) =>
          player.id ===
          onlyWinnerId
      );

    if (!onlyWinner) {
      tournament.championId =
        null;

      tournament.phase =
        "finished";

      return;
    }

    tournament.championId =
      onlyWinnerId;

    tournament.finalMatchId =
      null;

    tournament.finalPlayerIds =
      [];

    tournament.phase =
      "finished";

    onlyWinner.status =
      "champion";

    onlyWinner.eliminated =
      false;

    for (
      const player of
        tournament.players
    ) {
      if (
        player.id ===
        onlyWinnerId
      ) {
        continue;
      }

      if (
        player.status !==
        "left"
      ) {
        player.status =
          "eliminated";
      }

      player.eliminated =
        true;
    }

    return;
  }

  // ZERO WINNERS
  tournament.championId =
    null;

  tournament.finalMatchId =
    null;

  tournament.finalPlayerIds =
    [];

  tournament.phase =
    "finished";
}

// =============================================================================
// SEMIFINAL WINNER
// =============================================================================

function promoteSemifinalWinner(
  tournament,
  match
) {
  const semi =
    tournament.semifinals.find(
      (entry) =>
        entry.matchId ===
        match.id
    );

  if (
    !semi ||
    semi.complete
  ) {
    return;
  }

  semi.complete =
    true;

  semi.winnerId =
    match.seriesWinnerId ??
    match.winnerId ??
    null;

  const winner =
    tournament.players.find(
      (player) =>
        player.id ===
        semi.winnerId
    );

  const loser =
    tournament.players.find(
      (player) =>
        player.id !==
          semi.winnerId &&
        semi.playerIds.includes(
          player.id
        )
    );

  if (winner) {
    winner.status =
      "semifinal-winner";

    winner.eliminated =
      false;
  }

  if (loser) {
    loser.status =
      "eliminated";

    loser.eliminated =
      true;
  }

  createFinalIfReady(
    tournament
  );
}

// =============================================================================
// FORFEIT
//
// EXIT = immediate.
// No heartbeat grace.
// =============================================================================

function forfeitTwistMatch(
  match,
  exitingPlayerId
) {
  if (
    !match ||
    match.phase ===
      "finished"
  ) {
    return;
  }

  const exitingPlayer =
    match.players.find(
      (p) =>
        p.id ===
        exitingPlayerId
    );

  const winnerPlayer =
    match.players.find(
      (p) =>
        p.id !==
        exitingPlayerId
    );

  if (!winnerPlayer) {
    match.phase =
      "finished";

    match.winnerId =
      null;

    match.loserId =
      exitingPlayerId;

    match.readyDeadlineAt =
      null;

    return;
  }

  if (exitingPlayer) {
    exitingPlayer.ready =
      false;

    exitingPlayer.lastSeenAt =
      0;
  }

  match.forfeit =
    true;

  match.forfeitedPlayerId =
    exitingPlayerId;

  match.phase =
    "finished";

  match.raceStartAt =
    null;

  match.readyDeadlineAt =
    null;

  match.deadlineAt =
    null;

  match.firstSolverId =
    null;

  match.winnerId =
    winnerPlayer.id;

  match.loserId =
    exitingPlayerId;

  // Immediate 3-0.
  for (
    const player of
      match.players
  ) {
    match.seriesWins[
      player.id
    ] =
      player.id ===
      winnerPlayer.id
        ? TWIST_SERIES_WINS
        : Number(
            match.seriesWins[
              player.id
            ] || 0
          );
  }

  match.seriesWinnerId =
    winnerPlayer.id;

  const tournament =
    getTwistTournamentForMatch(
      match
    );

  if (!tournament) {
    return;
  }

  // SEMIFINAL FORFEIT
  if (
    match.stage ===
    "semifinal"
  ) {
    promoteSemifinalWinner(
      tournament,
      match
    );

    return;
  }

  // FINAL FORFEIT
  if (
    match.stage ===
    "final"
  ) {
    tournament.championId =
      winnerPlayer.id;

    tournament.phase =
      "finished";

    tournament.finalMatchId =
      match.id;

    tournament.finalPlayerIds =
      [winnerPlayer.id];

    const winner =
      tournament.players.find(
        (player) =>
          player.id ===
          winnerPlayer.id
      );

    const loser =
      tournament.players.find(
        (player) =>
          player.id ===
          exitingPlayerId
      );

    if (winner) {
      winner.status =
        "champion";

      winner.eliminated =
        false;
    }

    if (loser) {
      loser.status =
        "final-loser";

      loser.eliminated =
        false;
    }
  }
}

// =============================================================================
// SEMIFINAL WINNER EXIT
// =============================================================================

function resolveSemifinalExitWalkover(
  tournament,
  exitingPlayerId
) {
  if (
    !tournament ||
    isTwistTournamentFinished(
      tournament
    )
  ) {
    return;
  }

  for (
    const semi of
      tournament.semifinals
  ) {
    if (
      semi.winnerId ===
      exitingPlayerId
    ) {
      semi.winnerId =
        null;

      semi.complete =
        true;
    }
  }

  tournament.finalPlayerIds =
    tournament.finalPlayerIds.filter(
      (id) =>
        id !==
        exitingPlayerId
    );

  const exitingPlayer =
    tournament.players.find(
      (player) =>
        player.id ===
        exitingPlayerId
    );

  if (exitingPlayer) {
    exitingPlayer.status =
      "left";

    exitingPlayer.eliminated =
      true;

    exitingPlayer.finalMatchId =
      null;
  }

  createFinalIfReady(
    tournament
  );
}

// =============================================================================
// HEARTBEAT
// =============================================================================

function touchTwistPlayer(
  match,
  playerId
) {
  const player =
    match?.players.find(
      (p) =>
        p.id === playerId
    );

  if (!player) {
    return false;
  }

  const tournament =
    getTwistTournamentForMatch(
      match
    );

  const tournamentPlayer =
    tournament?.players.find(
      (p) =>
        p.id === playerId
    );

  if (
    tournamentPlayer?.status ===
    "left"
  ) {
    return false;
  }

  const now =
    Date.now();

  player.lastSeenAt =
    now;

  if (tournamentPlayer) {
    tournamentPlayer.lastSeenAt =
      now;
  }

  return true;
}

function resolveTwistDisconnects() {
  const now =
    Date.now();

  for (
    const match of
      twistLeagueMatches.values()
  ) {
    if (
      !match ||
      match.phase ===
        "finished"
    ) {
      continue;
    }

    if (
      !Array.isArray(
        match.players
      ) ||
      match.players.length !==
        2
    ) {
      continue;
    }

    const tournament =
      getTwistTournamentForMatch(
        match
      );

    const stale =
      match.players.filter(
        (player) => {
          const tournamentPlayer =
            tournament?.players.find(
              (p) =>
                p.id ===
                player.id
            );

          if (
            tournamentPlayer?.status ===
            "left"
          ) {
            return false;
          }

          const lastSeen =
            Number(
              player.lastSeenAt ||
                0
            );

          return (
            lastSeen > 0 &&
            now -
              lastSeen >
              TWIST_DISCONNECT_TIMEOUT_MS
          );
        }
      );

    // Both disconnected at exactly the same time:
    // do not arbitrarily award a win.
    if (
      stale.length !==
      1
    ) {
      continue;
    }

    const stalePlayer =
      stale[0];

    const livePlayer =
      match.players.find(
        (player) =>
          player.id !==
          stalePlayer.id
      );

    if (!livePlayer) {
      continue;
    }

    forfeitTwistMatch(
      match,
      stalePlayer.id
    );
  }
}

// =============================================================================
// HEARTBEAT ENDPOINT
// =============================================================================

app.post(
  "/api/twist-league/heartbeat",
  (req, res) => {
    const match =
      getTwistLeagueMatch(
        req
      );

    const playerId =
      String(
        req.body?.playerId ||
          ""
      );

    if (!match) {
      return res.status(404).json({
        error:
          "twist league match not found",
      });
    }

    if (
      !touchTwistPlayer(
        match,
        playerId
      )
    ) {
      return res.status(403).json({
        error:
          "player is not part of this match or already left",
      });
    }

    return res.json(
      twistLeagueSnapshot(
        match
      )
    );
  }
);

// =============================================================================
// DEBUG
// =============================================================================

app.get(
  "/api/twist-league/debug",
  (_req, res) => {
    cleanupTwistLeagueQueue();

    res.json({
      ok: true,

      queuedPlayers: [
        ...twistLeagueQueue.values(),
      ].map((entry) => ({
        playerId:
          entry.playerId,

        username:
          entry.username,
      })),

      tournaments: [
        ...twistLeagueTournaments.values(),
      ].map((tournament) => ({
        id:
          tournament.id,

        phase:
          tournament.phase,

        championId:
          tournament.championId,

        players:
          tournament.players,

        bracket:
          getTwistTournamentBracket(
            tournament
          ),
      })),

      activeMatches: [
        ...twistLeagueMatches.values(),
      ].map((match) => ({
        id:
          match.id,

        tournamentId:
          match.tournamentId,

        stage:
          match.stage,

        slot:
          match.slot,

        phase:
          match.phase,

        gameNumber:
          match.gameNumber,

        readyDeadlineAt:
          match.readyDeadlineAt ??
          null,

        seriesWins:
          match.seriesWins,

        seriesWinnerId:
          match.seriesWinnerId,

        winnerId:
          match.winnerId,

        loserId:
          match.loserId,

        forfeit:
          !!match.forfeit,

        forfeitedPlayerId:
          match.forfeitedPlayerId ??
          null,

        players:
          match.players.map(
            (player) => ({
              id:
                player.id,

              username:
                player.username,

              ready:
                player.ready,

              solveTimeMs:
                player.solveTimeMs,

              lastSeenAt:
                player.lastSeenAt,
            })
          ),
      })),
    });
  }
);

// =============================================================================
// JOIN - 4 PLAYER LOBBY / SPECTATOR REJOIN
// =============================================================================

app.post(
  "/api/twist-league/join",
  (req, res) => {
    cleanupTwistLeagueQueue();

    const playerId =
      String(
        req.body?.playerId ||
          randomUUID()
      );

    const username =
      normalizeUsername(
        req.body?.username
      );

    // -------------------------------------------------------------------------
    // ACTIVE TOURNAMENT
    // -------------------------------------------------------------------------

    const activeTournament =
      findActiveTwistTournamentByPlayerId(
        playerId
      );

    if (activeTournament) {
      const player =
        activeTournament.players.find(
          (entry) =>
            entry.id ===
            playerId
        );

      // IMPORTANT:
      // A player who already LEFT may re-open the tournament,
      // but ONLY AS A SPECTATOR.
      //
      // They cannot become active again.
      if (
        player?.status ===
        "left"
      ) {
        return res.json({
          status:
            "spectator",

          playerId,

          players:
            TWIST_PLAYER_CAPACITY,

          capacity:
            TWIST_PLAYER_CAPACITY,

          bracket:
            getTwistTournamentBracket(
              activeTournament
            ),
        });
      }

      const activeMatch =
        findActiveTwistMatchByPlayerId(
          playerId
        );

      if (activeMatch) {
        const me =
          activeMatch.players.find(
            (entry) =>
              entry.id ===
              playerId
          );

        if (me) {
          me.username =
            username;
        }

        return res.json({
          status:
            "matched",

          playerId,

          players:
            TWIST_PLAYER_CAPACITY,

          capacity:
            TWIST_PLAYER_CAPACITY,

          match:
            twistLeagueSnapshot(
              activeMatch
            ),
        });
      }

      // Player is waiting between rounds.
      if (player) {
        player.username =
          username;
      }

      const nextMatchId =
        player?.finalMatchId ??
        player?.semFinalMatchId ??
        null;

      const nextMatch =
        nextMatchId
          ? twistLeagueMatches.get(
              nextMatchId
            )
          : undefined;

      if (nextMatch) {
        return res.json({
          status:
            "matched",

          playerId,

          players:
            TWIST_PLAYER_CAPACITY,

          capacity:
            TWIST_PLAYER_CAPACITY,

          match:
            twistLeagueSnapshot(
              nextMatch
            ),
        });
      }

      return res.json({
        status:
          "waiting",

        playerId,

        players:
          TWIST_PLAYER_CAPACITY,

        capacity:
          TWIST_PLAYER_CAPACITY,

        bracket:
          getTwistTournamentBracket(
            activeTournament
          ),
      });
    }

    // -------------------------------------------------------------------------
    // HISTORICAL TOURNAMENT
    //
    // If this is an unfinished tournament and the player had left,
    // they may return ONLY to spectate.
    //
    // Finished tournament remains available as bracket history.
    // -------------------------------------------------------------------------

    const oldTournament =
      findTwistTournamentByPlayerId(
        playerId
      );

    if (oldTournament) {
      const oldPlayer =
        oldTournament.players.find(
          (entry) =>
            entry.id ===
            playerId
        );

      if (
        oldPlayer?.status ===
        "left"
      ) {
        return res.json({
          status:
            "spectator",

          playerId,

          players:
            TWIST_PLAYER_CAPACITY,

          capacity:
            TWIST_PLAYER_CAPACITY,

          bracket:
            getTwistTournamentBracket(
              oldTournament
            ),
        });
      }

      // Finished tournament:
      // allow the user to view the final bracket.
      if (
        isTwistTournamentFinished(
          oldTournament
        )
      ) {
        return res.json({
          status:
            "spectator",

          playerId,

          players:
            TWIST_PLAYER_CAPACITY,

          capacity:
            TWIST_PLAYER_CAPACITY,

          bracket:
            getTwistTournamentBracket(
              oldTournament
            ),
        });
      }
    }

    // -------------------------------------------------------------------------
    // QUEUE
    // -------------------------------------------------------------------------

    const existingQueueEntry =
      twistLeagueQueue.get(
        playerId
      );

    if (
      existingQueueEntry
    ) {
      existingQueueEntry.username =
        username;
    } else {
      twistLeagueQueue.set(
        playerId,
        {
          playerId,
          username,
          joinedAt:
            Date.now(),
        }
      );
    }

    const entries =
      [
        ...twistLeagueQueue.values(),
      ].slice(
        0,
        TWIST_PLAYER_CAPACITY
      );

    if (
      entries.length <
      TWIST_PLAYER_CAPACITY
    ) {
      return res.json({
        status:
          "searching",

        playerId,

        players:
          entries.length,

        capacity:
          TWIST_PLAYER_CAPACITY,
      });
    }

    for (
      const entry of entries
    ) {
      twistLeagueQueue.delete(
        entry.playerId
      );
    }

    const tournament =
      createFourPlayerTwistTournament(
        entries
      );

    const myMatch =
      findActiveTwistMatchByPlayerId(
        playerId
      );

    return res.json({
      status:
        "matched",

      playerId,

      players:
        TWIST_PLAYER_CAPACITY,

      capacity:
        TWIST_PLAYER_CAPACITY,

      match:
        myMatch
          ? twistLeagueSnapshot(
              myMatch
            )
          : null,

      bracket:
        getTwistTournamentBracket(
          tournament
        ),
    });
  }
);

// =============================================================================
// STATE
// =============================================================================

app.get(
  "/api/twist-league/state",
  (req, res) => {
    const match =
      getTwistLeagueMatch(
        req
      );

    if (!match) {
      return res.status(404).json({
        error:
          "twist league match not found",
      });
    }

    return res.json(
      twistLeagueSnapshot(
        match
      )
    );
  }
);

// =============================================================================
// READY
// =============================================================================

app.post(
  "/api/twist-league/ready",
  (req, res) => {
    const match =
      getTwistLeagueMatch(
        req
      );

    const playerId =
      String(
        req.body?.playerId ||
          ""
      );

    const player =
      match?.players.find(
        (p) =>
          p.id ===
          playerId
      );

    if (
      !match ||
      !player
    ) {
      return res.status(404).json({
        error:
          "twist league match/player not found",
      });
    }

    // Resolve an expired 90-second ready timer first.
    const resolved =
      resolveTwistReadyTimeout(
        match
      );

    if (
      resolved &&
      match.phase !==
        "ready"
    ) {
      return res.json(
        twistLeagueSnapshot(
          match
        )
      );
    }

    const tournament =
      getTwistTournamentForMatch(
        match
      );

    const tournamentPlayer =
      tournament?.players.find(
        (p) =>
          p.id ===
          playerId
      );

    // Explicitly left player can NEVER READY again.
    if (
      tournamentPlayer?.status ===
      "left"
    ) {
      return res.status(403).json({
        error:
          "player already exited this tournament",
      });
    }

    if (
      match.phase !==
      "ready"
    ) {
      return res.status(409).json({
        error:
          "match is not ready for READY state",
      });
    }

    if (
      !touchTwistPlayer(
        match,
        playerId
      )
    ) {
      return res.status(403).json({
        error:
          "player is not active in this match",
      });
    }

    player.ready =
      true;

    // Both ready = cancel the 90s ready timer.
    if (
      match.players.every(
        (p) => p.ready
      )
    ) {
      match.readyDeadlineAt =
        null;
    }

    return res.json(
      twistLeagueSnapshot(
        match
      )
    );
  }
);

// =============================================================================
// START
// =============================================================================

app.post(
  "/api/twist-league/start",
  (req, res) => {
    const match =
      getTwistLeagueMatch(
        req
      );

    const playerId =
      String(
        req.body?.playerId ||
          ""
      );

    const player =
      match?.players.find(
        (p) =>
          p.id === playerId
      );

    if (
      !match ||
      !player
    ) {
      return res.status(404).json({
        error:
          "twist league match/player not found",
      });
    }

    resolveTwistReadyTimeout(
      match
    );

    if (
      match.phase ===
      "finished"
    ) {
      return res.json(
        twistLeagueSnapshot(
          match
        )
      );
    }

    touchTwistPlayer(
      match,
      playerId
    );

    if (
      match.players.length !==
      2
    ) {
      return res.status(409).json({
        error:
          "Twist League match requires exactly 2 players per bracket game",
      });
    }

    if (
      !match.players.every(
        (p) => p.ready
      )
    ) {
      return res.status(409).json({
        error:
          "both bracket players must be ready",
      });
    }

    if (
      match.raceStartAt ===
      null
    ) {
      match.readyDeadlineAt =
        null;

      match.raceStartAt =
        Date.now() +
        TWIST_START_DELAY_MS;
    }

    return res.json(
      twistLeagueSnapshot(
        match
      )
    );
  }
);

// =============================================================================
// SOLVE
// =============================================================================

app.post(
  "/api/twist-league/solve",
  (req, res) => {
    const match =
      getTwistLeagueMatch(
        req
      );

    const playerId =
      String(
        req.body?.playerId ||
          ""
      );

    const player =
      match?.players.find(
        (p) =>
          p.id === playerId
      );

    if (
      !match ||
      !player
    ) {
      return res.status(404).json({
        error:
          "twist league match/player not found",
      });
    }

    touchTwistPlayer(
      match,
      playerId
    );

    advanceTwistLeagueMatch(
      match
    );

    if (
      match.phase !==
        "racing" ||
      player.solvedAt !==
        null
    ) {
      return res.json(
        twistLeagueSnapshot(
          match
        )
      );
    }

    const now =
      Date.now();

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

    // Finish window.
    if (
      match.deadlineAt !==
        null &&
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
        first?.id ??
        null;

      match.loserId =
        player.id;

      if (
        first?.id
      ) {
        match.seriesWins[
          first.id
        ] =
          Number(
            match.seriesWins[
              first.id
            ] || 0
          ) + 1;
      }

      completeTwistSeriesIfNeeded(
        match
      );

      return res.json(
        twistLeagueSnapshot(
          match
        )
      );
    }

    player.startedAt =
      startAt;

    player.solvedAt =
      acceptedSolvedAt;

    player.solveTimeMs =
      solveTimeMs;

    // First solver.
    if (
      match.firstSolverId ===
      null
    ) {
      match.firstSolverId =
        player.id;

      match.deadlineAt =
        acceptedSolvedAt +
        TWIST_FINISH_WINDOW_MS;

      return res.json(
        twistLeagueSnapshot(
          match
        )
      );
    }

    const first =
      match.players.find(
        (p) =>
          p.id ===
          match.firstSolverId
      );

    if (
      !first ||
      first.solveTimeMs === null
    ) {
      return res.status(409).json({
        error:
          "first solver state is incomplete",
      });
    }

    const secondTime =
      player.solveTimeMs;

    const firstTime =
      first.solveTimeMs;

    const winnerId =
      secondTime <
      firstTime
        ? player.id
        : first.id;

    const loserId =
      winnerId ===
      player.id
        ? first.id
        : player.id;

    match.winnerId =
      winnerId;

    match.loserId =
      loserId;

    match.phase =
      "finished";

    match.seriesWins[
      winnerId
    ] =
      Number(
        match.seriesWins[
          winnerId
        ] || 0
      ) + 1;

    match.lastGameResult = {
      gameNumber:
        match.gameNumber,

      winnerId,

      loserId,

      playerTimes: {
        [player.id]:
          player.solveTimeMs,

        [first.id]:
          first.solveTimeMs,
      },

      seriesWins: {
        ...match.seriesWins,
      },
    };

    completeTwistSeriesIfNeeded(
      match
    );

    return res.json(
      twistLeagueSnapshot(
        match
      )
    );
  }
);

// =============================================================================
// TIMEOUT
// =============================================================================

app.post(
  "/api/twist-league/timeout",
  (req, res) => {
    const match =
      getTwistLeagueMatch(
        req
      );

    if (!match) {
      return res.status(404).json({
        error:
          "twist league match not found",
      });
    }

    const playerId =
      String(
        req.body?.playerId ||
          ""
      );

    if (
      !match.players.some(
        (p) =>
          p.id === playerId
      )
    ) {
      return res.status(403).json({
        error:
          "player is not part of this match",
      });
    }

    // READY timeout gets first priority.
    const readyResolved =
      resolveTwistReadyTimeout(
        match
      );

    if (
      readyResolved
    ) {
      return res.json(
        twistLeagueSnapshot(
          match
        )
      );
    }

    if (
      match.phase ===
      "finished"
    ) {
      return res.json(
        twistLeagueSnapshot(
          match
        )
      );
    }

    advanceTwistLeagueMatch(
      match
    );

    if (
      match.phase !==
        "racing" ||
      !match.firstSolverId ||
      !match.deadlineAt
    ) {
      return res.json(
        twistLeagueSnapshot(
          match
        )
      );
    }

    if (
      Date.now() <
      match.deadlineAt
    ) {
      return res.json(
        twistLeagueSnapshot(
          match
        )
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

    let winnerId =
      first?.id ??
      null;

    let loserId =
      second?.id ??
      null;

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

      winnerId =
        secondTime <
        firstTime
          ? second.id
          : first?.id ??
            null;

      loserId =
        secondTime <
        firstTime
          ? first?.id ??
            null
          : second.id;
    }

    match.phase =
      "finished";

    match.winnerId =
      winnerId;

    match.loserId =
      loserId;

    if (winnerId) {
      match.seriesWins[
        winnerId
      ] =
        Number(
          match.seriesWins[
            winnerId
          ] || 0
        ) + 1;
    }

    completeTwistSeriesIfNeeded(
      match
    );

    return res.json(
      twistLeagueSnapshot(
        match
      )
    );
  }
);

// =============================================================================
// NEXT GAME
// =============================================================================

app.post(
  "/api/twist-league/next-game",
  (req, res) => {
    const match =
      getTwistLeagueMatch(
        req
      );

    const playerId =
      String(
        req.body?.playerId ||
          ""
      );

    if (!match) {
      return res.status(404).json({
        error:
          "twist league match not found",
      });
    }

    const player =
      match.players.find(
        (p) =>
          p.id === playerId
      );

    if (!player) {
      return res.status(403).json({
        error:
          "player is not part of this match",
      });
    }

    if (
      match.seriesWinnerId
    ) {
      return res.json(
        twistLeagueSnapshot(
          match
        )
      );
    }

    // Already prepared next game.
    if (
      match.phase === "ready" &&
      match.raceStartAt === null &&
      match.readyDeadlineAt !== null &&
      match.firstSolverId === null &&
      match.deadlineAt === null &&
      match.winnerId === null &&
      match.loserId === null
    ) {
      touchTwistPlayer(
        match,
        playerId
      );

      return res.json(
        twistLeagueSnapshot(
          match
        )
      );
    }

    if (
      match.phase !==
      "finished"
    ) {
      return res.status(409).json({
        error:
          "current game is not finished",
      });
    }

    if (
      match.seriesWinnerId
    ) {
      return res.json(
        twistLeagueSnapshot(
          match
        )
      );
    }

    prepareNextTwistGame(
      match
    );

    touchTwistPlayer(
      match,
      playerId
    );

    return res.json(
      twistLeagueSnapshot(
        match
      )
    );
  }
);

// =============================================================================
// LEAVE / EXIT
// =============================================================================

app.post(
  "/api/twist-league/leave",
  (req, res) => {
    const playerId =
      String(
        req.body?.playerId ||
          ""
      );

    // Remove from queue.
    twistLeagueQueue.delete(
      playerId
    );

    const tournament =
      findTwistTournamentByPlayerId(
        playerId
      );

    // Finished tournament:
    // harmless exit, no lock.
    if (
      tournament &&
      isTwistTournamentFinished(
        tournament
      )
    ) {
      return res.json({
        ok: true,

        status:
          "finished-no-lock",

        tournamentId:
          tournament.id,

        bracket:
          getTwistTournamentBracket(
            tournament
          ),
      });
    }

    if (!tournament) {
      return res.json({
        ok: true,

        status:
          "already-left-or-finished",
      });
    }

    const player =
      tournament.players.find(
        (entry) =>
          entry.id ===
          playerId
      );

    if (!player) {
      return res.json({
        ok: true,
      });
    }

    // Mark permanently LEFT for this tournament.
    player.status =
      "left";

    player.eliminated =
      true;

    player.lastSeenAt =
      0;

    player.finalMatchId =
      null;

    // Explicit EXIT is instant loss.
    const activeMatch =
      findActiveTwistMatchByPlayerId(
        playerId
      );

    if (
      activeMatch
    ) {
      forfeitTwistMatch(
        activeMatch,
        playerId
      );

      return res.json({
        ok: true,

        status:
          "forfeited",

        match:
          twistLeagueSnapshot(
            activeMatch
          ),
      });
    }

    // Player already won semifinal and is waiting:
    // remove them from finalist eligibility.
    resolveSemifinalExitWalkover(
      tournament,
      playerId
    );

    return res.json({
      ok: true,

      status:
        "left-bracket",

      tournamentId:
        tournament.id,

      bracket:
        getTwistTournamentBracket(
          tournament
        ),
    });
  }
);

// =============================================================================
// READY TIMEOUT RESOLVER
// =============================================================================

function resolveTwistReadyTimeout(
  match
) {
  if (!match) {
    return false;
  }

  if (
    match.phase !==
    "ready"
  ) {
    return false;
  }

  if (
    match.raceStartAt !==
    null
  ) {
    return false;
  }

  if (
    !match.readyDeadlineAt
  ) {
    return false;
  }

  const now =
    Date.now();

  if (
    now <
    match.readyDeadlineAt
  ) {
    return false;
  }

  const readyPlayers =
    match.players.filter(
      (player) =>
        player.ready
    );

  // ===========================================================================
  // 0 READY
  //
  // Consume the game.
  // No point.
  // New scramble.
  // New 90 sec timer.
  // ===========================================================================

  if (
    readyPlayers.length ===
    0
  ) {
    prepareNextTwistGame(
      match
    );

    return true;
  }

  // ===========================================================================
  // 1 READY
  //
  // READY player wins the game.
  // ===========================================================================

  if (
    readyPlayers.length ===
    1
  ) {
    const winner =
      readyPlayers[0];

    const loser =
      match.players.find(
        (player) =>
          player.id !==
          winner.id
      );

    if (!loser) {
      prepareNextTwistGame(
        match
      );

      return true;
    }

    match.phase =
      "finished";

    match.raceStartAt =
      null;

    match.readyDeadlineAt =
      null;

    match.firstSolverId =
      null;

    match.deadlineAt =
      null;

    match.winnerId =
      winner.id;

    match.loserId =
      loser.id;

    match.seriesWins[
      winner.id
    ] =
      Number(
        match.seriesWins[
          winner.id
        ] || 0
      ) + 1;

    match.lastGameResult = {
      gameNumber:
        match.gameNumber,

      winnerId:
        winner.id,

      loserId:
        loser.id,

      playerTimes: {
        [winner.id]:
          null,

        [loser.id]:
          null,
      },

      seriesWins: {
        ...match.seriesWins,
      },
    };

    completeTwistSeriesIfNeeded(
      match
    );

    return true;
  }

  // ===========================================================================
  // 2 READY
  //
  // Normal start.
  // ===========================================================================

  match.readyDeadlineAt =
    null;

  return false;
}

// =============================================================================
// QUEUE CLEANUP
// =============================================================================

setInterval(
  cleanupTwistLeagueQueue,
  5000
);

// =============================================================================
// READY WATCHDOG
// =============================================================================

setInterval(() => {
  for (
    const match of
      twistLeagueMatches.values()
  ) {
    if (
      !match ||
      match.phase !==
        "ready"
    ) {
      continue;
    }

    resolveTwistReadyTimeout(
      match
    );
  }
}, 1000);

// =============================================================================
// HEARTBEAT WATCHDOG
// =============================================================================

setInterval(
  resolveTwistDisconnects,
  TWIST_HEARTBEAT_INTERVAL_MS
);

// =============================================================================
// START SERVER
// =============================================================================

app.listen(
  PORT,
  "0.0.0.0",
  () => {
    console.log(
      `[api] CubePulse public server listening on ${PORT}`
    );
  }
);
