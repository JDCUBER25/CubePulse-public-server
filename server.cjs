const express = require('express');
const { randomUUID } = require('crypto');

const app = express();
const PORT = Number(process.env.PORT || 10000);

app.use(express.json());

// -----------------------------------------------------------------------------
// CORS
// -----------------------------------------------------------------------------
app.use((req, res, next) => {
  const origin = req.headers.origin;

  if (origin) {
    res.header('Access-Control-Allow-Origin', origin);
  }

  res.header(
    'Access-Control-Allow-Methods',
    'GET, POST, OPTIONS'
  );

  res.header(
    'Access-Control-Allow-Headers',
    'Origin, X-Requested-With, Content-Type, Accept, Authorization'
  );

  if (req.method === 'OPTIONS') {
    return res.sendStatus(204);
  }

  next();
});

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------
function normalizeScramble(value) {
  return String(value ?? '')
    .trim()
    .replace(/\s+/g, ' ');
}

function normalizeUsername(value) {
  const username = String(value ?? '')
    .trim()
    .replace(/\s+/g, ' ');

  return username.slice(0, 20) || 'Player';
}

function generateScramble(length = 20) {
  const faces = ['R', 'L', 'U', 'D', 'F', 'B'];
  const suffixes = ['', "'", '2'];

  const result = [];
  let lastFace = '';

  while (result.length < length) {
    const face =
      faces[Math.floor(Math.random() * faces.length)];

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

  return result.join(' ');
}

// -----------------------------------------------------------------------------
// Existing 1v1 Battle /api/matchmaking/*
// -----------------------------------------------------------------------------
const queue = new Map();
const matches = new Map();

function findActiveMatchByPlayerId(
  playerId,
  store = matches
) {
  for (const match of store.values()) {
    if (
      match.phase !== 'finished' &&
      match.players.some(
        (player) => player.id === playerId
      )
    ) {
      return match;
    }
  }

  return undefined;
}

function advanceMatch(match) {
  if (
    match.phase === 'ready' &&
    match.raceStartAt !== null &&
    Date.now() >= match.raceStartAt
  ) {
    match.phase = 'racing';

    for (const player of match.players) {
      if (player.startedAt === null) {
        player.startedAt =
          match.raceStartAt;
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
      ''
  );

  return matches.get(id);
}

// -----------------------------------------------------------------------------
// Health
// -----------------------------------------------------------------------------
app.get(
  '/api/health',
  (_req, res) => {
    res.json({
      ok: true,
      service: 'cubepulse-matchmaking',
      timestamp: Date.now(),
    });
  }
);

// -----------------------------------------------------------------------------
// 1v1 Debug
// -----------------------------------------------------------------------------
app.get(
  '/api/matchmaking/debug',
  (_req, res) => {
    res.json({
      ok: true,

      queuedPlayers:
        [...queue.values()].map(
          (entry) => ({
            playerId:
              entry.playerId,
            username:
              entry.username,
          })
        ),

      activeMatches:
        [...matches.values()].map(
          (match) => ({
            id:
              match.id,

            phase:
              match.phase,

            players:
              match.players.map(
                (player) => ({
                  id:
                    player.id,
                  username:
                    player.username,
                  ready:
                    player.ready,
                })
              ),
          })
        ),
    });
  }
);

// -----------------------------------------------------------------------------
// 1v1 JOIN
// -----------------------------------------------------------------------------
app.post(
  '/api/matchmaking/join',
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
            player.id ===
            playerId
        );

      if (me) {
        me.username =
          username;
      }

      return res.json({
        status:
          'matched',

        playerId,

        match:
          snapshot(existing),
      });
    }

    const requested =
      normalizeScramble(
        req.body?.scramble
      );

    const scramble =
      requested ||
      generateScramble();

    for (const [key, entry] of queue) {
      if (
        entry.playerId ===
        playerId
      ) {
        queue.delete(
          key
        );
      }
    }

    const opponent =
      [...queue.entries()].find(
        ([, entry]) =>
          entry.playerId !==
          playerId
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
        status:
          'searching',

        playerId,
      });
    }

    queue.delete(
      opponent[0]
    );

    const match = {
      id:
        randomUUID(),

      scramble:
        opponent[1].scramble ||
        scramble,

      phase:
        'ready',

      raceStartAt:
        null,

      firstSolverId:
        null,

      deadlineAt:
        null,

      winnerId:
        null,

      loserId:
        null,

      players: [
        {
          id:
            opponent[1].playerId,

          username:
            opponent[1].username,

          ready:
            false,

          startedAt:
            null,

          solvedAt:
            null,

          solveTimeMs:
            null,
        },

        {
          id:
            playerId,

          username:
            username,

          ready:
            false,

          startedAt:
            null,

          solvedAt:
            null,

          solveTimeMs:
            null,
        },
      ],
    };

    matches.set(
      match.id,
      match
    );

    return res.json({
      status:
        'matched',

      playerId,

      match:
        snapshot(match),
    });
  }
);

// -----------------------------------------------------------------------------
// 1v1 STATE
// -----------------------------------------------------------------------------
app.get(
  '/api/matchmaking/state',
  (req, res) => {
    const match =
      getMatch(req);

    if (!match) {
      return res
        .status(404)
        .json({
          error:
            'match not found',
        });
    }

    return res.json(
      snapshot(match)
    );
  }
);

// -----------------------------------------------------------------------------
// 1v1 READY
// -----------------------------------------------------------------------------
app.post(
  '/api/matchmaking/ready',
  (req, res) => {
    const match =
      getMatch(req);

    const playerId =
      String(
        req.body?.playerId ||
          ''
      );

    const player =
      match?.players.find(
        (p) =>
          p.id ===
          playerId
      );

    if (!match || !player) {
      return res
        .status(404)
        .json({
          error:
            'match/player not found',
        });
    }

    player.ready =
      true;

    return res.json(
      snapshot(match)
    );
  }
);

// -----------------------------------------------------------------------------
// 1v1 START
// -----------------------------------------------------------------------------
app.post(
  '/api/matchmaking/start',
  (req, res) => {
    const match =
      getMatch(req);

    const playerId =
      String(
        req.body?.playerId ||
          ''
      );

    const player =
      match?.players.find(
        (p) =>
          p.id ===
          playerId
      );

    if (!match || !player) {
      return res
        .status(404)
        .json({
          error:
            'match/player not found',
        });
    }

    if (
      !match.players.every(
        (p) =>
          p.ready
      )
    ) {
      return res
        .status(409)
        .json({
          error:
            'both players must be ready',
        });
    }

    if (
      match.raceStartAt ===
      null
    ) {
      match.raceStartAt =
        Date.now() +
        3000;
    }

    return res.json(
      snapshot(match)
    );
  }
);

// -----------------------------------------------------------------------------
// 1v1 SOLVE
// -----------------------------------------------------------------------------
app.post(
  '/api/matchmaking/solve',
  (req, res) => {
    const match =
      getMatch(req);

    const playerId =
      String(
        req.body?.playerId ||
          ''
      );

    const player =
      match?.players.find(
        (p) =>
          p.id ===
          playerId
      );

    if (!match || !player) {
      return res
        .status(404)
        .json({
          error:
            'match/player not found',
        });
    }

    advanceMatch(
      match
    );

    if (
      match.phase !==
        'racing' ||
      player.solvedAt !==
        null
    ) {
      return res.json(
        snapshot(match)
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
        'finished';

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
        acceptedSolvedAt +
        15000;

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
      first.solveTimeMs ==
        null
    ) {
      return res
        .status(409)
        .json({
          error:
            'first solver state is incomplete',
        });
    }

    const secondTime =
      player.solveTimeMs;

    const firstTime =
      first.solveTimeMs;

    match.phase =
      'finished';

    match.winnerId =
      secondTime <
      firstTime
        ? player.id
        : first.id;

    match.loserId =
      secondTime <
      firstTime
        ? first.id
        : player.id;

    return res.json(
      snapshot(match)
    );
  }
);

// -----------------------------------------------------------------------------
// 1v1 TIMEOUT
// -----------------------------------------------------------------------------
app.post(
  '/api/matchmaking/timeout',
  (req, res) => {
    const match =
      getMatch(req);

    const playerId =
      String(
        req.body?.playerId ||
          ''
      );

    if (!match) {
      return res
        .status(404)
        .json({
          error:
            'match not found',
        });
    }

    if (
      !match.players.some(
        (p) =>
          p.id ===
          playerId
      )
    ) {
      return res
        .status(403)
        .json({
          error:
            'player is not part of this match',
        });
    }

    advanceMatch(
      match
    );

    if (
      match.phase ===
      'finished'
    ) {
      return res.json(
        snapshot(match)
      );
    }

    if (
      match.phase !==
        'racing' ||
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
        'finished';

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

      return res.json(
        snapshot(match)
      );
    }

    match.phase =
      'finished';

    match.winnerId =
      first?.id ??
      null;

    match.loserId =
      second?.id ??
      null;

    return res.json(
      snapshot(match)
    );
  }
);

// -----------------------------------------------------------------------------
// 1v1 LEAVE
// -----------------------------------------------------------------------------
app.post(
  '/api/matchmaking/leave',
  (req, res) => {
    queue.delete(
      String(
        req.body?.playerId ||
          ''
      )
    );

    return res.json({
      ok: true,
    });
  }
);

// =============================================================================
// TWIST LEAGUE / 4-PLAYER TOURNAMENT
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

// BO3 = first to 3 series wins.
const TWIST_SERIES_WINS =
  3;

const TWIST_FINISH_WINDOW_MS =
  15000;

const TWIST_START_DELAY_MS =
  3000;

// Heartbeat policy.
//
// Temporary network loss:
//   heartbeat stops
//   player gets grace period
//   player may reconnect
//
// No heartbeat beyond timeout:
//   automatic forfeit
//
// Explicit EXIT:
//   instant forfeit, no grace period
//
const TWIST_HEARTBEAT_INTERVAL_MS =
  1000;

const TWIST_DISCONNECT_TIMEOUT_MS =
  12000;

// -----------------------------------------------------------------------------
// Queue cleanup
// -----------------------------------------------------------------------------
function cleanupTwistLeagueQueue() {
  const now =
    Date.now();

  for (
    const [key, entry] of
      twistLeagueQueue
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

// -----------------------------------------------------------------------------
// Tournament finished check
// -----------------------------------------------------------------------------
function isTwistTournamentFinished(
  tournament
) {
  if (!tournament) {
    return false;
  }

  if (
    tournament.phase ===
    'finished'
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
        'finished' &&
      finalMatch.seriesWinnerId
    ) {
      return true;
    }
  }

  return false;
}

// -----------------------------------------------------------------------------
// Find ACTIVE tournament by player
// -----------------------------------------------------------------------------
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
          player.id ===
          playerId
      )
    ) {
      return tournament;
    }
  }

  return undefined;
}

// -----------------------------------------------------------------------------
// Find ACTIVE match by player
// -----------------------------------------------------------------------------
function findActiveTwistMatchByPlayerId(
  playerId
) {
  for (
    const match of
      twistLeagueMatches.values()
  ) {
    if (
      match.phase !==
        'finished' &&
      match.players.some(
        (player) =>
          player.id ===
          playerId
      )
    ) {
      return match;
    }
  }

  return undefined;
}

// -----------------------------------------------------------------------------
// Find ANY historical tournament by player
// -----------------------------------------------------------------------------
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
          p.id ===
          playerId
      );

    if (player) {
      return tournament;
    }
  }

  return undefined;
}

// -----------------------------------------------------------------------------
// Create tournament player
// -----------------------------------------------------------------------------
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
      'waiting',

    eliminated:
      false,

    lastSeenAt:
      Date.now(),
  };
}

// -----------------------------------------------------------------------------
// Create 2-player match
// -----------------------------------------------------------------------------
function createTwistMatch({
  tournamentId,
  stage,
  slot,
  players,
}) {
  const seriesWins =
    {};

  for (
    const player of
      players
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
      'BO3',

    capacity:
      2,

    phase:
      'ready',

    scramble:
      generateScramble(),

    raceStartAt:
      null,

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

// -----------------------------------------------------------------------------
// Bracket snapshot
// -----------------------------------------------------------------------------
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

            playerIds:
              [
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

                    seriesWins:
                      {
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

    final:
      {
        matchId:
          tournament.finalMatchId,

        playerIds:
          [
            ...tournament.finalPlayerIds,
          ],

        winnerId:
          tournament.phase ===
              'finished'
            ? tournament.championId
            : null,

        complete:
          tournament.phase ===
          'finished',

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

                seriesWins:
                  {
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

// -----------------------------------------------------------------------------
// Match clock
// -----------------------------------------------------------------------------
function advanceTwistLeagueMatch(
  match
) {
  if (
    match.phase ===
      'ready' &&
    match.raceStartAt !==
      null &&
    Date.now() >=
      match.raceStartAt
  ) {
    match.phase =
      'racing';

    for (
      const player of
        match.players
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

// -----------------------------------------------------------------------------
// Tournament for match
// -----------------------------------------------------------------------------
function getTwistTournamentForMatch(
  match
) {
  return twistLeagueTournaments.get(
    match.tournamentId
  );
}

// -----------------------------------------------------------------------------
// Match snapshot
// -----------------------------------------------------------------------------
function twistLeagueSnapshot(
  match
) {
  advanceTwistLeagueMatch(
    match
  );

  const tournament =
    getTwistTournamentForMatch(
      match
    );

  return {
    ...match,

    tournamentId:
      tournament?.id ??
      match.tournamentId,

    bracket:
      tournament
        ? getTwistTournamentBracket(
            tournament
          )
        : null,

    players:
      match.players.map(
        (player) => ({
          ...player,
        })
      ),
  };
}

// -----------------------------------------------------------------------------
// Get Twist match
// -----------------------------------------------------------------------------
function getTwistLeagueMatch(
  req
) {
  const id =
    String(
      req.body?.matchId ??
        req.query?.matchId ??
        ''
    );

  return twistLeagueMatches.get(
    id
  );
}

// -----------------------------------------------------------------------------
// Assign semifinal player status
// -----------------------------------------------------------------------------
function assignSemifinalStatus(
  tournament,
  playerIds,
  matchId
) {
  for (
    const id of
      playerIds
  ) {
    const player =
      tournament.players.find(
        (p) =>
          p.id ===
          id
      );

    if (!player) {
      continue;
    }

    player.semFinalMatchId =
      matchId;

    player.status =
      'semifinal';

    player.eliminated =
      false;
  }
}

// -----------------------------------------------------------------------------
// Create 4-player tournament
// -----------------------------------------------------------------------------
function createFourPlayerTwistTournament(
  entries
) {
  const players =
    entries.map(
      (entry, index) =>
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
      'semifinals',

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
        'semifinal',

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
        'semifinal',

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

// -----------------------------------------------------------------------------
// Create Final OR award walkover
//
// IMPORTANT:
//   winners.length === 2
//       => create actual Final
//
//   winners.length === 1
//       => the other semifinal winner must have LEFT
//       => remaining player becomes Champion
//       => DO NOT create Final
//
//   winners.length === 0
//       => no Champion; terminal broken/empty tournament
// -----------------------------------------------------------------------------
function createFinalIfReady(
  tournament
) {
  if (
    tournament.phase !==
    'semifinals'
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

  // ---------------------------------------------------------------------------
  // NORMAL CASE: TWO SEMIFINAL WINNERS
  // ---------------------------------------------------------------------------
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
      'final';

    const finalMatch =
      createTwistMatch({
        tournamentId:
          tournament.id,

        stage:
          'final',

        slot:
          1,

        players:
          finalPlayers,
      });

    tournament.finalMatchId =
      finalMatch.id;

    for (
      const player of
        finalPlayers
    ) {
      player.finalMatchId =
        finalMatch.id;

      player.status =
        'final';

      player.eliminated =
        false;
    }

    twistLeagueMatches.set(
      finalMatch.id,
      finalMatch
    );

    return;
  }

  // ---------------------------------------------------------------------------
  // WALKOVER CASE: ONE SEMIFINAL WINNER REMAINS
  //
  // Example:
  //
  // Semi 1:
  //   Luigi exits
  //   Ren wins
  //
  // Ren later exits while Semi 2 is ongoing.
  //
  // Semi 2 eventually completes:
  //   Jay wins
  //
  // winners = [Jay]
  //
  // Therefore Jay is Champion automatically.
  // NO FINAL.
  // ---------------------------------------------------------------------------
  if (
    winners.length ===
    1
  ) {
    const championId =
      winners[0];

    const champion =
      tournament.players.find(
        (player) =>
          player.id ===
          championId
      );

    if (!champion) {
      tournament.championId =
        null;

      tournament.finalMatchId =
        null;

      tournament.finalPlayerIds =
        [];

      tournament.phase =
        'finished';

      return;
    }

    tournament.championId =
      championId;

    tournament.finalMatchId =
      null;

    tournament.finalPlayerIds =
      [];

    tournament.phase =
      'finished';

    champion.status =
      'champion';

    champion.eliminated =
      false;

    for (
      const player of
        tournament.players
    ) {
      if (
        player.id ===
        championId
      ) {
        continue;
      }

      if (
        player.status !==
        'left'
      ) {
        player.status =
          'eliminated';
      }

      player.eliminated =
        true;
    }

    return;
  }

  // ---------------------------------------------------------------------------
  // ZERO WINNERS
  // ---------------------------------------------------------------------------
  tournament.championId =
    null;

  tournament.finalMatchId =
    null;

  tournament.finalPlayerIds =
    [];

  tournament.phase =
    'finished';
}

// -----------------------------------------------------------------------------
// Semifinal winner promotion
// -----------------------------------------------------------------------------
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
      'semifinal-winner';

    winner.eliminated =
      false;
  }

  if (loser) {
    loser.status =
      'eliminated';

    loser.eliminated =
      true;
  }

  // This handles:
  //   2 semifinal winners -> Final
  //   1 remaining winner -> Champion by walkover
  createFinalIfReady(
    tournament
  );
}

// -----------------------------------------------------------------------------
// Complete BO3 series
// -----------------------------------------------------------------------------
function completeTwistSeriesIfNeeded(
  match
) {
  const seriesWins =
    match.seriesWins ??
    {};

  const winnerId =
    Object.entries(
      seriesWins
    ).find(
      ([, wins]) =>
        Number(wins) >=
        TWIST_SERIES_WINS
    )?.[0] ??
    null;

  if (!winnerId) {
    return false;
  }

  const loserId =
    match.players.find(
      (player) =>
        player.id !==
        winnerId
    )?.id ??
    null;

  match.seriesWinnerId =
    winnerId;

  match.winnerId =
    winnerId;

  match.loserId =
    loserId;

  match.phase =
    'finished';

  match.raceStartAt =
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

  // ---------------------------------------------------------------------------
  // SEMIFINAL COMPLETE
  // ---------------------------------------------------------------------------
  if (
    match.stage ===
    'semifinal'
  ) {
    promoteSemifinalWinner(
      tournament,
      match
    );

    return true;
  }

  // ---------------------------------------------------------------------------
  // ACTUAL FINAL COMPLETE
  // ---------------------------------------------------------------------------
  if (
    match.stage ===
    'final'
  ) {
    tournament.championId =
      winnerId;

    tournament.phase =
      'finished';

    const winner =
      tournament.players.find(
        (player) =>
          player.id ===
          winnerId
      );

    const loser =
      tournament.players.find(
        (player) =>
          player.id ===
          loserId
      );

    if (winner) {
      winner.status =
        'champion';

      winner.eliminated =
        false;
    }

    if (loser) {
      loser.status =
        'final-loser';

      loser.eliminated =
        true;
    }
  }

  return true;
}

// -----------------------------------------------------------------------------
// Forfeit / EXIT
//
// EXPLICIT EXIT IS IMMEDIATE.
// No heartbeat grace applies.
//
// Important:
// If a semifinal winner exits while the other semifinal is still ongoing,
// this player is removed from Final eligibility.
// When the other semifinal completes, the remaining winner receives
// Championship by walkover.
// -----------------------------------------------------------------------------
function forfeitTwistMatch(
  match,
  exitingPlayerId
) {
  if (
    !match ||
    match.phase ===
      'finished'
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
      'finished';

    match.winnerId =
      null;

    match.loserId =
      exitingPlayerId;

    return;
  }

  if (exitingPlayer) {
    exitingPlayer.ready =
      false;

    // STOP heartbeat relevance for this player immediately.
    exitingPlayer.lastSeenAt =
      0;
  }

  match.forfeit =
    true;

  match.forfeitedPlayerId =
    exitingPlayerId;

  match.phase =
    'finished';

  match.raceStartAt =
    null;

  match.deadlineAt =
    null;

  match.firstSolverId =
    null;

  match.winnerId =
    winnerPlayer.id;

  match.loserId =
    exitingPlayerId;

  // Immediate 3-0 series win by forfeit.
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

  // ---------------------------------------------------------------------------
  // SEMIFINAL FORFEIT
  // ---------------------------------------------------------------------------
  if (
    match.stage ===
    'semifinal'
  ) {
    promoteSemifinalWinner(
      tournament,
      match
    );

    // The winner is still a finalist candidate.
    // It may later EXIT from the bracket while the other semi is running.
    return;
  }

  // ---------------------------------------------------------------------------
  // FINAL FORFEIT
  // ---------------------------------------------------------------------------
  if (
    match.stage ===
    'final'
  ) {
    tournament.championId =
      winnerPlayer.id;

    tournament.phase =
      'finished';

    tournament.finalMatchId =
      match.id;

    tournament.finalPlayerIds =
      [
        winnerPlayer.id,
      ];

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
        'champion';

      winner.eliminated =
        false;
    }

    if (loser) {
      loser.status =
        'left';

      loser.eliminated =
        true;
    }
  }
}

// -----------------------------------------------------------------------------
// Resolve a semifinal winner EXIT.
//
// This is for the case where a player has already won a semifinal,
// but the other semifinal has not finished yet.
//
// Example:
//   Semi 1 winner = Ren
//   Ren exits
//   Semi 2 = Jay vs Niel still running
//
// Semi 1 becomes winnerId = null.
// Tournament remains active.
// When Semi 2 finishes, createFinalIfReady() sees one winner and
// awards Champion by walkover.
// -----------------------------------------------------------------------------
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

      // Keep the semifinal complete because the match itself was already
      // decided by forfeit. The player simply loses Final eligibility.
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
      'left';

    exitingPlayer.eliminated =
      true;

    exitingPlayer.finalMatchId =
      null;
  }

  // If both semis are already complete, decide immediately.
  createFinalIfReady(
    tournament
  );
}

// -----------------------------------------------------------------------------
// HEARTBEAT
// -----------------------------------------------------------------------------
function touchTwistPlayer(
  match,
  playerId
) {
  const player =
    match?.players.find(
      (p) =>
        p.id ===
        playerId
    );

  if (!player) {
    return false;
  }

  // A player that explicitly left is not allowed to revive by heartbeat.
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

  if (
    tournamentPlayer?.status ===
    'left'
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

// -----------------------------------------------------------------------------
// Disconnect watchdog
//
// NOTE:
//   A temporary Wi-Fi interruption is NOT an instant forfeit.
//
//   EXIT is instant because /leave calls forfeitTwistMatch() directly.
//
//   Disconnect only forfeits after TWIST_DISCONNECT_TIMEOUT_MS.
// -----------------------------------------------------------------------------
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
        'finished'
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

          // Explicitly left players are handled by /leave.
          if (
            tournamentPlayer?.status ===
            'left'
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

    // Both gone at once:
    // don't arbitrarily award a win yet.
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

// -----------------------------------------------------------------------------
// HEARTBEAT ENDPOINT
// -----------------------------------------------------------------------------
app.post(
  '/api/twist-league/heartbeat',
  (req, res) => {
    const match =
      getTwistLeagueMatch(
        req
      );

    const playerId =
      String(
        req.body?.playerId ||
          ''
      );

    if (!match) {
      return res
        .status(404)
        .json({
          error:
            'twist league match not found',
        });
    }

    if (
      !touchTwistPlayer(
        match,
        playerId
      )
    ) {
      return res
        .status(403)
        .json({
          error:
            'player is not part of this match or already left',
        });
    }

    return res.json(
      twistLeagueSnapshot(
        match
      )
    );
  }
);

// -----------------------------------------------------------------------------
// DEBUG
// -----------------------------------------------------------------------------
app.get(
  '/api/twist-league/debug',
  (_req, res) => {
    cleanupTwistLeagueQueue();

    return res.json({
      ok: true,

      queuedPlayers:
        [
          ...twistLeagueQueue.values()
        ].map(
          (entry) => ({
            playerId:
              entry.playerId,

            username:
              entry.username,
          })
        ),

      tournaments:
        [
          ...twistLeagueTournaments.values()
        ].map(
          (tournament) => ({
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
          })
        ),

      activeMatches:
        [
          ...twistLeagueMatches.values()
        ].map(
          (match) => ({
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
          })
        ),
    });
  }
);

// -----------------------------------------------------------------------------
// JOIN - 4 PLAYER LOBBY
// -----------------------------------------------------------------------------
app.post(
  '/api/twist-league/join',
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

      // Explicit EXIT locks player out of THIS ACTIVE tournament.
      if (
        player?.status ===
        'left'
      ) {
        return res
          .status(409)
          .json({
            error:
              'You already exited this Twist League tournament and cannot rejoin it.',

            tournamentId:
              activeTournament.id,
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
            'matched',

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

      // Player is between matches / watching bracket.
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

      if (
        nextMatch
      ) {
        return res.json({
          status:
            'matched',

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
          'waiting',

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
    // Historical tournament:
    // Finished tournaments NEVER block a new join.
    //
    // Only an unfinished tournament with status "left" blocks the same player.
    // -------------------------------------------------------------------------
    const oldTournament =
      findTwistTournamentByPlayerId(
        playerId
      );

    if (
      oldTournament &&
      !isTwistTournamentFinished(
        oldTournament
      )
    ) {
      const oldPlayer =
        oldTournament.players.find(
          (entry) =>
            entry.id ===
            playerId
        );

      if (
        oldPlayer?.status ===
        'left'
      ) {
        return res
          .status(409)
          .json({
            error:
              'You already exited this Twist League tournament and cannot rejoin it.',

            tournamentId:
              oldTournament.id,
          });
      }
    }

    // -------------------------------------------------------------------------
    // Queue
    //
    // IMPORTANT:
    // Do not delete and reinsert an existing queue entry.
    // Map insertion order becomes seed order.
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
        ...twistLeagueQueue.values()
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
          'searching',

        playerId,

        players:
          entries.length,

        capacity:
          TWIST_PLAYER_CAPACITY,
      });
    }

    // Remove exactly these four.
    for (
      const entry of
        entries
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
        'matched',

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

// -----------------------------------------------------------------------------
// STATE
// -----------------------------------------------------------------------------
app.get(
  '/api/twist-league/state',
  (req, res) => {
    const match =
      getTwistLeagueMatch(
        req
      );

    if (!match) {
      return res
        .status(404)
        .json({
          error:
            'twist league match not found',
        });
    }

    return res.json(
      twistLeagueSnapshot(
        match
      )
    );
  }
);

// -----------------------------------------------------------------------------
// READY
// -----------------------------------------------------------------------------
app.post(
  '/api/twist-league/ready',
  (req, res) => {
    const match =
      getTwistLeagueMatch(
        req
      );

    const playerId =
      String(
        req.body?.playerId ||
          ''
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
      return res
        .status(404)
        .json({
          error:
            'twist league match/player not found',
        });
    }

    // An explicitly left player cannot READY again.
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

    if (
      tournamentPlayer?.status ===
      'left'
    ) {
      return res
        .status(403)
        .json({
          error:
            'player already exited this tournament',
        });
    }

    if (
      match.phase !==
      'ready'
    ) {
      return res
        .status(409)
        .json({
          error:
            'match is not ready for READY state',
        });
    }

    touchTwistPlayer(
      match,
      playerId
    );

    player.ready =
      true;

    return res.json(
      twistLeagueSnapshot(
        match
      )
    );
  }
);

// -----------------------------------------------------------------------------
// START
// -----------------------------------------------------------------------------
app.post(
  '/api/twist-league/start',
  (req, res) => {
    const match =
      getTwistLeagueMatch(
        req
      );

    const playerId =
      String(
        req.body?.playerId ||
          ''
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
      return res
        .status(404)
        .json({
          error:
            'twist league match/player not found',
        });
    }

    touchTwistPlayer(
      match,
      playerId
    );

    if (
      match.players.length !==
      2
    ) {
      return res
        .status(409)
        .json({
          error:
            'Twist League match requires exactly 2 players per bracket game',
        });
    }

    if (
      !match.players.every(
        (p) =>
          p.ready
      )
    ) {
      return res
        .status(409)
        .json({
          error:
            'both bracket players must be ready',
        });
    }

    if (
      match.raceStartAt ===
      null
    ) {
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

// -----------------------------------------------------------------------------
// SOLVE
// -----------------------------------------------------------------------------
app.post(
  '/api/twist-league/solve',
  (req, res) => {
    const match =
      getTwistLeagueMatch(
        req
      );

    const playerId =
      String(
        req.body?.playerId ||
          ''
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
      return res
        .status(404)
        .json({
          error:
            'twist league match/player not found',
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
        'racing' ||
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

    // If opponent already solved and the finish window expired.
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
        'finished';

      match.winnerId =
        first?.id ??
        null;

      match.loserId =
        player.id;

      // Make the round count.
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
      first.solveTimeMs ==
        null
    ) {
      return res
        .status(409)
        .json({
          error:
            'first solver state is incomplete',
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
      'finished';

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

      winnerId:
        winnerId,

      loserId:
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

// -----------------------------------------------------------------------------
// TIMEOUT
// -----------------------------------------------------------------------------
app.post(
  '/api/twist-league/timeout',
  (req, res) => {
    const match =
      getTwistLeagueMatch(
        req
      );

    if (!match) {
      return res
        .status(404)
        .json({
          error:
            'twist league match not found',
        });
    }

    advanceTwistLeagueMatch(
      match
    );

    if (
      match.phase ===
      'finished'
    ) {
      return res.json(
        twistLeagueSnapshot(
          match
        )
      );
    }

    if (
      match.phase !==
        'racing' ||
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
      'finished';

    match.winnerId =
      winnerId;

    match.loserId =
      loserId;

    if (
      winnerId
    ) {
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

// -----------------------------------------------------------------------------
// NEXT GAME
// -----------------------------------------------------------------------------
app.post(
  '/api/twist-league/next-game',
  (req, res) => {
    const match =
      getTwistLeagueMatch(
        req
      );

    const playerId =
      String(
        req.body?.playerId ||
          ''
      );

    if (!match) {
      return res
        .status(404)
        .json({
          error:
            'twist league match not found',
        });
    }

    const player =
      match.players.find(
        (p) =>
          p.id ===
          playerId
      );

    if (!player) {
      return res
        .status(403)
        .json({
          error:
            'player is not part of this match',
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

    // Already-reset next game.
    if (
      match.phase ===
        'ready' &&
      match.raceStartAt ===
        null &&
      match.firstSolverId ===
        null &&
      match.deadlineAt ===
        null &&
      match.winnerId ===
        null &&
      match.loserId ===
        null &&
      match.players.every(
        (p) =>
          p.ready ===
            false &&
          p.startedAt ===
            null &&
          p.solvedAt ===
            null &&
          p.solveTimeMs ===
            null
      )
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
      'finished'
    ) {
      return res
        .status(409)
        .json({
          error:
            'current game is not finished',
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

    match.gameNumber +=
      1;

    match.scramble =
      generateScramble();

    match.phase =
      'ready';

    match.raceStartAt =
      null;

    match.firstSolverId =
      null;

    match.deadlineAt =
      null;

    match.winnerId =
      null;

    match.loserId =
      null;

    for (
      const player of
        match.players
    ) {
      player.ready =
        false;

      player.lastSeenAt =
        Date.now();

      player.startedAt =
        null;

      player.solvedAt =
        null;

      player.solveTimeMs =
        null;
    }

    return res.json(
      twistLeagueSnapshot(
        match
      )
    );
  }
);

// -----------------------------------------------------------------------------
// LEAVE / EXIT
//
// IMPORTANT:
//   - Finished tournament -> harmless exit, no lock.
//   - Active current match -> immediate forfeit.
//   - Semifinal winner waiting for other semifinal -> remove from finalist
//     eligibility and allow walkover logic to resolve later.
// -----------------------------------------------------------------------------
app.post(
  '/api/twist-league/leave',
  (req, res) => {
    const playerId =
      String(
        req.body?.playerId ||
          ''
      );

    // Remove from queue immediately.
    twistLeagueQueue.delete(
      playerId
    );

    // Find any tournament record.
    const tournament =
      findTwistTournamentByPlayerId(
        playerId
      );

    // -------------------------------------------------------------------------
    // FINISHED TOURNAMENT
    //
    // Important:
    // A completed tournament must never lock the user out of the next one.
    // -------------------------------------------------------------------------
    if (
      tournament &&
      isTwistTournamentFinished(
        tournament
      )
    ) {
      return res.json({
        ok: true,

        status:
          'finished-no-lock',

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
          'already-left-or-finished',
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

    // -------------------------------------------------------------------------
    // ACTIVE TOURNAMENT: PLAYER IS NOW PERMANENTLY LEFT
    // -------------------------------------------------------------------------
    player.status =
      'left';

    player.eliminated =
      true;

    player.lastSeenAt =
      0;

    player.finalMatchId =
      null;

    player.semFinalMatchId =
      player.semFinalMatchId ??
      null;

    // -------------------------------------------------------------------------
    // ACTIVE MATCH FORFEIT
    //
    // Explicit EXIT = INSTANT WIN.
    // No heartbeat grace.
    // -------------------------------------------------------------------------
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

      const snapshotData =
        twistLeagueSnapshot(
          activeMatch
        );

      return res.json({
        ok: true,

        status:
          'forfeited',

        match:
          snapshotData,
      });
    }

    // -------------------------------------------------------------------------
    // PLAYER MAY BE A SEMIFINAL WINNER WAITING FOR THE OTHER SEMIFINAL.
    //
    // Remove them from any semifinal winner slot immediately.
    // The surviving semifinal winner will later receive walkover if necessary.
    // -------------------------------------------------------------------------
    resolveSemifinalExitWalkover(
      tournament,
      playerId
    );

    return res.json({
      ok: true,

      status:
        'left-bracket',

      tournamentId:
        tournament.id,

      bracket:
        getTwistTournamentBracket(
          tournament
        ),
    });
  }
);

// -----------------------------------------------------------------------------
// Queue cleanup
// -----------------------------------------------------------------------------
setInterval(
  cleanupTwistLeagueQueue,
  5000
);

// -----------------------------------------------------------------------------
// Disconnect watchdog
// -----------------------------------------------------------------------------
setInterval(
  resolveTwistDisconnects,
  TWIST_HEARTBEAT_INTERVAL_MS
);

// -----------------------------------------------------------------------------
// START SERVER
// -----------------------------------------------------------------------------
app.listen(
  PORT,
  '0.0.0.0',
  () => {
    console.log(
      `[api] CubePulse public server listening on ${PORT}`
    );
  }
);
