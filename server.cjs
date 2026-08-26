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

    if (face === lastFace) continue;

    const suffix =
      suffixes[Math.floor(Math.random() * suffixes.length)];

    result.push(face + suffix);
    lastFace = face;
  }

  return result.join(' ');
}

// -----------------------------------------------------------------------------
// Existing Tournament /api/matchmaking/* state
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
    players: match.players.map((player) => ({
      ...player,
    })),
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

app.get(
  '/api/matchmaking/debug',
  (_req, res) => {
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
  }
);

// -----------------------------------------------------------------------------
// Tournament JOIN
// -----------------------------------------------------------------------------
app.post(
  '/api/matchmaking/join',
  (req, res) => {
    const playerId = String(
      req.body?.playerId || randomUUID()
    );

    const username = normalizeUsername(
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
        status: 'matched',
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

    for (const [key, entry] of queue) {
      if (entry.playerId === playerId) {
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
        status: 'searching',
        playerId,
      });
    }

    queue.delete(opponent[0]);

    const match = {
      id: randomUUID(),
      scramble:
        opponent[1].scramble ||
        scramble,
      phase: 'ready',
      raceStartAt: null,
      firstSolverId: null,
      deadlineAt: null,
      winnerId: null,
      loserId: null,
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
    };

    matches.set(match.id, match);

    return res.json({
      status: 'matched',
      playerId,
      match: snapshot(match),
    });
  }
);

// -----------------------------------------------------------------------------
// Tournament STATE
// -----------------------------------------------------------------------------
app.get(
  '/api/matchmaking/state',
  (req, res) => {
    const match = getMatch(req);

    if (!match) {
      return res.status(404).json({
        error: 'match not found',
      });
    }

    return res.json(snapshot(match));
  }
);

// -----------------------------------------------------------------------------
// Tournament READY
// -----------------------------------------------------------------------------
app.post(
  '/api/matchmaking/ready',
  (req, res) => {
    const match = getMatch(req);

    const playerId = String(
      req.body?.playerId || ''
    );

    const player =
      match?.players.find(
        (p) => p.id === playerId
      );

    if (!match || !player) {
      return res.status(404).json({
        error: 'match/player not found',
      });
    }

    player.ready = true;

    return res.json(
      snapshot(match)
    );
  }
);

// -----------------------------------------------------------------------------
// Tournament START
// -----------------------------------------------------------------------------
app.post(
  '/api/matchmaking/start',
  (req, res) => {
    const match = getMatch(req);

    const playerId = String(
      req.body?.playerId || ''
    );

    const player =
      match?.players.find(
        (p) => p.id === playerId
      );

    if (!match || !player) {
      return res.status(404).json({
        error: 'match/player not found',
      });
    }

    if (
      !match.players.every(
        (p) => p.ready
      )
    ) {
      return res.status(409).json({
        error:
          'both players must be ready',
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

// -----------------------------------------------------------------------------
// Tournament SOLVE
// -----------------------------------------------------------------------------
app.post(
  '/api/matchmaking/solve',
  (req, res) => {
    const match = getMatch(req);

    const playerId = String(
      req.body?.playerId || ''
    );

    const player =
      match?.players.find(
        (p) => p.id === playerId
      );

    if (!match || !player) {
      return res.status(404).json({
        error: 'match/player not found',
      });
    }

    advanceMatch(match);

    if (
      match.phase !== 'racing' ||
      player.solvedAt !== null
    ) {
      return res.json(
        snapshot(match)
      );
    }

    const now = Date.now();

    const requestedSolvedAt =
      Number(req.body?.solvedAt);

    const requestedElapsedMs =
      Number(req.body?.elapsedMs);

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

    const calculated = Math.max(
      1,
      acceptedSolvedAt - startAt
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
      return res.status(409).json({
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
// Tournament TIMEOUT
// -----------------------------------------------------------------------------
app.post(
  '/api/matchmaking/timeout',
  (req, res) => {
    const match = getMatch(req);

    if (!match) {
      return res.status(404).json({
        error: 'match not found',
      });
    }

    advanceMatch(match);

    if (
      match.phase ===
      'finished'
    ) {
      return res.json(
        snapshot(match)
      );
    }

    if (
      match.phase !== 'racing' ||
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
      first?.id ?? null;

    match.loserId =
      second?.id ?? null;

    return res.json(
      snapshot(match)
    );
  }
);

// -----------------------------------------------------------------------------
// Tournament LEAVE
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
// TWIST LEAGUE
// =============================================================================
// Separate subsystem from /api/matchmaking/*.
// Battle.tsx uses the 1v1 matchmaking routes.
// TournamentLeague.tsx uses this 4-player bracket subsystem.
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

// -----------------------------------------------------------------------------
// Twist queue cleanup
// -----------------------------------------------------------------------------
function cleanupTwistLeagueQueue() {
  const now =
    Date.now();

  for (
    const [key, entry]
    of twistLeagueQueue
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
// Find active tournament only
// IMPORTANT:
// A player who exited cannot rejoin THIS active tournament.
// Once tournament is finished, the same player may join a future tournament.
// -----------------------------------------------------------------------------
function findActiveTwistTournamentByPlayerId(
  playerId
) {
  for (
    const tournament
    of twistLeagueTournaments.values()
  ) {
    if (
      tournament.phase ===
      'finished'
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

function findActiveTwistMatchByPlayerId(
  playerId
) {
  for (
    const match
    of twistLeagueMatches.values()
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

function findTwistTournamentByPlayerId(
  playerId
) {
  for (
    const tournament
    of twistLeagueTournaments.values()
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

// -----------------------------------------------------------------------------
// Players
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
    semFinalMatchId: null,
    finalMatchId: null,
    status: 'waiting',
    eliminated: false,
  };
}

// -----------------------------------------------------------------------------
// Match
// -----------------------------------------------------------------------------
function createTwistMatch({
  tournamentId,
  stage,
  slot,
  players,
}) {
  const seriesWins = {};

  for (
    const player of players
  ) {
    seriesWins[player.id] = 0;
  }

  return {
    id: randomUUID(),
    tournamentId,
    stage,
    slot,
    format: 'BO3',
    capacity: 2,
    phase: 'ready',
    scramble:
      generateScramble(),
    raceStartAt: null,
    firstSolverId: null,
    deadlineAt: null,
    winnerId: null,
    loserId: null,
    seriesWins,
    gameNumber: 1,
    seriesWinnerId: null,
    lastGameResult: null,
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
      tournament.players.find(
        (player) =>
          player.id ===
          tournament.championId
      )?.username ??
      null,

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
              [...semi.playerIds],

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
                        ...(semiMatch.seriesWins ??
                          {}),
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

    final: (() => {
      const finalMatch =
        tournament.finalMatchId
          ? twistLeagueMatches.get(
              tournament.finalMatchId
            )
          : null;

      return {
        matchId:
          tournament.finalMatchId,

        playerIds:
          [
            ...tournament.finalPlayerIds,
          ],

        winnerId:
          tournament.championId,

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
                    ...(finalMatch.seriesWins ??
                      {}),
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
      };
    })(),
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
// Snapshot
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
    const id of playerIds
  ) {
    const player =
      tournament.players.find(
        (p) =>
          p.id === id
      );

    if (player) {
      player.semFinalMatchId =
        matchId;

      player.status =
        'semifinal';

      player.eliminated =
        false;
    }
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
        slot: 1,
        matchId: null,
        playerIds: [
          players[0].id,
          players[1].id,
        ],
        winnerId: null,
        complete: false,
      },

      {
        slot: 2,
        matchId: null,
        playerIds: [
          players[2].id,
          players[3].id,
        ],
        winnerId: null,
        complete: false,
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

      slot: 1,

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

      slot: 2,

      players: [
        players[2],
        players[3],
      ],
    });

  tournament.semifinals[0].matchId =
    semifinalA.id;

  tournament.semifinals[1].matchId =
    semifinalB.id;

  assignSemifinalStatus(
    tournament,
    tournament.semifinals[0].playerIds,
    semifinalA.id
  );

  assignSemifinalStatus(
    tournament,
    tournament.semifinals[1].playerIds,
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
// Create final from semifinal winners
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

  // Both winners must exist for a normal final.
  if (
    winners.length !== 2
  ) {
    return;
  }

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
    finalPlayers.length !== 2
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

      slot: 1,

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
    match.seriesWins ?? {};

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

  if (
    match.stage ===
    'semifinal'
  ) {
    promoteSemifinalWinner(
      tournament,
      match
    );
  } else if (
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
// Forfeit / EXIT handling
//
// This is the important new part:
//
// 1. The exiting player is marked "left".
// 2. The active match is NOT deleted.
// 3. The remaining player instantly wins.
// 4. A semifinal immediately promotes.
// 5. A final immediately produces Champion.
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
    // Keep the player in the match snapshot so every other device can see
    // that this player left/forfeited.
    exitingPlayer.ready =
      false;
  }

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

  // Immediate series win:
  // the remaining player is treated as having won the BO3 3-0 by forfeit.
  for (
    const player of
    match.players
  ) {
    match.seriesWins[player.id] =
      player.id === winnerPlayer.id
        ? TWIST_SERIES_WINS
        : Number(
            match.seriesWins[player.id] ||
              0
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

  if (
    match.stage ===
    'semifinal'
  ) {
    promoteSemifinalWinner(
      tournament,
      match
    );

    return;
  }

  if (
    match.stage ===
    'final'
  ) {
    tournament.championId =
      winnerPlayer.id;

    tournament.phase =
      'finished';

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
// If a semifinal winner leaves from the bracket BEFORE the other semifinal
// finishes, the remaining semifinal winner will later receive a walkover.
// -----------------------------------------------------------------------------
function resolveSemifinalExitWalkover(
  tournament
) {
  if (
    tournament.phase !==
    'semifinals'
  ) {
    return;
  }

  const completed =
    tournament.semifinals.filter(
      (semi) =>
        semi.complete
    );

  if (
    completed.length !== 2
  ) {
    return;
  }

  const winners =
    tournament.semifinals
      .map(
        (semi) =>
          semi.winnerId
      )
      .filter(Boolean);

  if (
    winners.length === 2
  ) {
    createFinalIfReady(
      tournament
    );

    return;
  }

  if (
    winners.length === 1
  ) {
    const championId =
      winners[0];

    tournament.championId =
      championId;

    tournament.phase =
      'finished';

    const winner =
      tournament.players.find(
        (player) =>
          player.id ===
          championId
      );

    if (winner) {
      winner.status =
        'champion';

      winner.eliminated =
        false;
    }
  }
}

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
    // ACTIVE TOURNAMENT LOCK
    //
    // If player already belongs to an active tournament:
    // - "left" => cannot rejoin same tournament
    // - otherwise return their current state
    //
    // Finished tournament does NOT block a future tournament.
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

      // Player may be waiting on the bracket between matches.
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
    // Also check an old tournament record.
    //
    // If it is finished, the player is free to join a NEW tournament.
    // If it is active and was marked left, the active check above would catch it.
    // -------------------------------------------------------------------------
    const oldTournament =
      findTwistTournamentByPlayerId(
        playerId
      );

    if (
      oldTournament &&
      oldTournament.phase !==
        'finished'
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

    // IMPORTANT:
    // The Twist League client polls /join repeatedly while searching.
    // Do NOT delete + reinsert an existing player here. Map insertion order
    // determines tournament seed order, so reinserting would make players
    // change positions/seeds while they are waiting.
    const existingQueueEntry =
      twistLeagueQueue.get(
        playerId
      );

    if (existingQueueEntry) {
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

    // Remove exact four entries.
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
      requestedElapsedMs >
        0
        ? Math.round(
            requestedElapsedMs
          )
        : 0;

    const solveTimeMs =
      Math.max(
        1,
        clientElapsed >
          0
          ? clientElapsed
          : calculated
      );

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

    // Save the round winner in the series score.
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
          p.ready === false &&
          p.startedAt ===
            null &&
          p.solvedAt ===
            null &&
          p.solveTimeMs ===
            null
      )
    ) {
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

    // Find the active tournament.
    const tournament =
      findActiveTwistTournamentByPlayerId(
        playerId
      );

    if (!tournament) {
      // It may already be in a finished tournament,
      // in which case this is just a harmless exit.
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
    // LOCK THIS PLAYER OUT OF THIS TOURNAMENT.
    // -------------------------------------------------------------------------
    player.status =
      'left';

    player.eliminated =
      true;

    // -------------------------------------------------------------------------
    // ACTIVE MATCH FORFEIT
    // -------------------------------------------------------------------------
    const activeMatch =
      findActiveTwistMatchByPlayerId(
        playerId
      );

    if (activeMatch) {
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
    // PLAYER MAY HAVE EXITED FROM THE BRACKET WHILE WAITING.
    //
    // If this player was already a semifinal winner and one of the two
    // semifinal slots is now empty, leave the tournament in a consistent state.
    // -------------------------------------------------------------------------
    for (
      const semi of
      tournament.semifinals
    ) {
      if (
        semi.winnerId ===
        playerId
      ) {
        semi.winnerId =
          null;
      }
    }

    // Remove a leaving player from an unstarted future Final.
    tournament.finalPlayerIds =
      tournament.finalPlayerIds.filter(
        (id) =>
          id !==
          playerId
      );

    resolveSemifinalExitWalkover(
      tournament
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
// Start
// -----------------------------------------------------------------------------
setInterval(
  cleanupTwistLeagueQueue,
  5000
);

app.listen(
  PORT,
  '0.0.0.0',
  () => {
    console.log(
      `[api] CubePulse public server listening on ${PORT}`
    );
  }
);
