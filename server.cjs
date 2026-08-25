server_4player_twist_league.cjs


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
    res.header(
      'Access-Control-Allow-Origin',
      origin
    );
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
  const faces = [
    'R',
    'L',
    'U',
    'D',
    'F',
    'B',
  ];

  const suffixes = [
    '',
    "'",
    '2',
  ];

  const result = [];
  let lastFace = '';

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

    result.push(
      face + suffix
    );

    lastFace = face;
  }

  return result.join(' ');
}

// -----------------------------------------------------------------------------
// Existing Tournament /api/matchmaking/* state
// IMPORTANT: keep this completely separate from Twist League.
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
    match.phase === 'ready' &&
    match.raceStartAt !== null &&
    Date.now() >=
      match.raceStartAt
  ) {
    match.phase = 'racing';

    for (
      const player of match.players
    ) {
      if (
        player.startedAt === null
      ) {
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

    players:
      match.players.map(
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

app.get(
  '/api/health',
  (_req, res) => {
    res.json({
      ok: true,
      service:
        'cubepulse-matchmaking',
      timestamp: Date.now(),
    });
  }
);

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
            id: match.id,

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
// Tournament JOIN / MATCHMAKING
// -----------------------------------------------------------------------------
app.post(
  '/api/matchmaking/join',
  (req, res) => {
    const playerId =
      String(
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

    for (
      const [key, entry] of queue
    ) {
      if (
        entry.playerId ===
        playerId
      ) {
        queue.delete(key);
      }
    }

    const opponent =
      [
        ...queue.entries()
      ].find(
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
            opponent[1]
              .playerId,

          username:
            opponent[1]
              .username,

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
// Tournament MATCH STATE
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
// Tournament READY
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

    if (
      !match ||
      !player
    ) {
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
// Tournament START
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

    if (
      !match ||
      !player
    ) {
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
// Tournament SOLVE
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

    if (
      !match ||
      !player
    ) {
      return res
        .status(404)
        .json({
          error:
            'match/player not found',
        });
    }

    advanceMatch(match);

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
// Tournament TIMEOUT
// -----------------------------------------------------------------------------
app.post(
  '/api/matchmaking/timeout',
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

// -----------------------------------------------------------------------------
// Twist League /api/twist-league/* state
// 4-player bracket:
//   QF/1/2 slots -> Semifinal A + Semifinal B -> Final -> Champion
//
// Each semifinal/final remains a normal 2-player BO3 match, but the
// tournament lobby waits for FOUR players before creating the bracket.
// -----------------------------------------------------------------------------
const twistLeagueQueue = new Map();
const twistLeagueMatches = new Map();
const twistLeagueTournaments = new Map();

const TWIST_QUEUE_TTL_MS = 15_000;
const TWIST_PLAYER_CAPACITY = 4;
const TWIST_SERIES_WINS = 3;
const TWIST_FINISH_WINDOW_MS = 15_000;
const TWIST_START_DELAY_MS = 3_000;

function cleanupTwistLeagueQueue() {
  const now = Date.now();

  for (const [key, entry] of twistLeagueQueue) {
    if (
      !entry.joinedAt ||
      now - entry.joinedAt > TWIST_QUEUE_TTL_MS
    ) {
      twistLeagueQueue.delete(key);
    }
  }
}

function findActiveTwistMatchByPlayerId(playerId) {
  for (const match of twistLeagueMatches.values()) {
    if (
      match.phase !== 'finished' &&
      match.players.some((player) => player.id === playerId)
    ) {
      return match;
    }
  }

  return undefined;
}

function findTwistTournamentByPlayerId(playerId) {
  for (const tournament of twistLeagueTournaments.values()) {
    const player = tournament.players.find((p) => p.id === playerId);
    if (player) return tournament;
  }

  return undefined;
}

function createTwistPlayer(id, username, seed) {
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

function createTwistMatch({ tournamentId, stage, slot, players }) {
  return {
    id: randomUUID(),
    tournamentId,
    stage,
    slot,
    format: 'BO3',
    capacity: 2,
    phase: 'ready',
    scramble: generateScramble(),
    raceStartAt: null,
    firstSolverId: null,
    deadlineAt: null,
    winnerId: null,
    loserId: null,
    seriesWins: {},
    gameNumber: 1,
    seriesWinnerId: null,
    players: players.map((player) => ({
      id: player.id,
      username: player.username,
      ready: false,
      startedAt: null,
      solvedAt: null,
      solveTimeMs: null,
    })),
  };
}

function getTwistTournamentBracket(tournament) {
  return {
    tournamentId: tournament.id,
    capacity: TWIST_PLAYER_CAPACITY,
    joinedPlayers: tournament.players.length,
    totalPlayers: TWIST_PLAYER_CAPACITY,
    phase: tournament.phase,
    championId: tournament.championId,
    championName:
      tournament.players.find(
        (player) => player.id === tournament.championId
      )?.username ?? null,
    slots: tournament.players.map((player) => ({
      seed: player.seed,
      id: player.id,
      username: player.username,
      status: player.status,
      eliminated: player.eliminated,
      semifinalMatchId: player.semFinalMatchId,
      finalMatchId: player.finalMatchId,
    })),
    semifinals: tournament.semifinals.map((semi) => ({
      slot: semi.slot,
      matchId: semi.matchId,
      playerIds: [...semi.playerIds],
      winnerId: semi.winnerId,
      complete: semi.complete,
    })),
    final: {
      matchId: tournament.finalMatchId,
      playerIds: [...tournament.finalPlayerIds],
      winnerId: tournament.championId,
      complete: tournament.phase === 'finished',
    },
  };
}

function advanceTwistLeagueMatch(match) {
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

function getTwistTournamentForMatch(match) {
  return twistLeagueTournaments.get(match.tournamentId);
}

function twistLeagueSnapshot(match) {
  advanceTwistLeagueMatch(match);

  const tournament = getTwistTournamentForMatch(match);

  return {
    ...match,
    tournamentId: tournament?.id ?? match.tournamentId,
    bracket: tournament
      ? getTwistTournamentBracket(tournament)
      : null,
    players: match.players.map((player) => ({ ...player })),
  };
}

function getTwistLeagueMatch(req) {
  const id = String(
    req.body?.matchId ??
      req.query?.matchId ??
      ''
  );

  return twistLeagueMatches.get(id);
}

function assignSemifinalStatus(tournament, playerIds, matchId) {
  for (const id of playerIds) {
    const player = tournament.players.find((p) => p.id === id);
    if (player) {
      player.semFinalMatchId = matchId;
      player.status = 'semifinal';
    }
  }
}

function createFourPlayerTwistTournament(entries) {
  const players = entries.map((entry, index) =>
    createTwistPlayer(
      entry.playerId,
      entry.username,
      index + 1
    )
  );

  const tournament = {
    id: randomUUID(),
    capacity: TWIST_PLAYER_CAPACITY,
    phase: 'semifinals',
    players,
    semifinals: [
      {
        slot: 1,
        matchId: null,
        playerIds: [players[0].id, players[1].id],
        winnerId: null,
        complete: false,
      },
      {
        slot: 2,
        matchId: null,
        playerIds: [players[2].id, players[3].id],
        winnerId: null,
        complete: false,
      },
    ],
    finalMatchId: null,
    finalPlayerIds: [],
    championId: null,
  };

  const semifinalA = createTwistMatch({
    tournamentId: tournament.id,
    stage: 'semifinal',
    slot: 1,
    players: [players[0], players[1]],
  });

  const semifinalB = createTwistMatch({
    tournamentId: tournament.id,
    stage: 'semifinal',
    slot: 2,
    players: [players[2], players[3]],
  });

  tournament.semifinals[0].matchId = semifinalA.id;
  tournament.semifinals[1].matchId = semifinalB.id;

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

  twistLeagueMatches.set(semifinalA.id, semifinalA);
  twistLeagueMatches.set(semifinalB.id, semifinalB);
  twistLeagueTournaments.set(tournament.id, tournament);

  return tournament;
}

function promoteSemifinalWinner(tournament, match) {
  const semi = tournament.semifinals.find(
    (entry) => entry.matchId === match.id
  );

  if (!semi || semi.complete) {
    return;
  }

  semi.complete = true;
  semi.winnerId = match.seriesWinnerId ?? match.winnerId ?? null;

  const winner = tournament.players.find(
    (player) => player.id === semi.winnerId
  );

  const loser = tournament.players.find(
    (player) => player.id !== semi.winnerId &&
      semi.playerIds.includes(player.id)
  );

  if (winner) {
    winner.status = 'semifinal-winner';
  }

  if (loser) {
    loser.status = 'eliminated';
    loser.eliminated = true;
  }

  const allSemifinalsComplete = tournament.semifinals.every(
    (entry) => entry.complete
  );

  if (!allSemifinalsComplete) {
    return;
  }

  const winners = tournament.semifinals
    .map((entry) => entry.winnerId)
    .filter(Boolean);

  if (winners.length !== 2) {
    return;
  }

  const finalPlayers = winners.map((id) =>
    tournament.players.find((player) => player.id === id)
  ).filter(Boolean);

  tournament.finalPlayerIds = finalPlayers.map((player) => player.id);
  tournament.phase = 'final';

  const finalMatch = createTwistMatch({
    tournamentId: tournament.id,
    stage: 'final',
    slot: 1,
    players: finalPlayers,
  });

  tournament.finalMatchId = finalMatch.id;

  for (const player of finalPlayers) {
    player.finalMatchId = finalMatch.id;
    player.status = 'final';
  }

  twistLeagueMatches.set(finalMatch.id, finalMatch);
}

function completeTwistSeriesIfNeeded(match) {
  const seriesWins = match.seriesWins;

  const winnerId = Object.entries(seriesWins).find(
    ([, wins]) => Number(wins) >= TWIST_SERIES_WINS
  )?.[0] ?? null;

  if (!winnerId) {
    return false;
  }

  const loserId = match.players.find(
    (player) => player.id !== winnerId
  )?.id ?? null;

  match.seriesWinnerId = winnerId;
  match.winnerId = winnerId;
  match.loserId = loserId;

  const tournament = getTwistTournamentForMatch(match);

  if (tournament) {
    if (match.stage === 'semifinal') {
      promoteSemifinalWinner(tournament, match);
    } else if (match.stage === 'final') {
      tournament.championId = winnerId;
      tournament.phase = 'finished';

      const winner = tournament.players.find(
        (player) => player.id === winnerId
      );

      const loser = tournament.players.find(
        (player) => player.id === loserId
      );

      if (winner) winner.status = 'champion';
      if (loser) {
        loser.status = 'final-loser';
        loser.eliminated = true;
      }
    }
  }

  return true;
}

function resetTwistGame(match) {
  match.scramble = generateScramble();
  match.phase = 'ready';
  match.raceStartAt = null;
  match.firstSolverId = null;
  match.deadlineAt = null;
  match.winnerId = null;
  match.loserId = null;

  for (const player of match.players) {
    player.ready = false;
    player.startedAt = null;
    player.solvedAt = null;
    player.solveTimeMs = null;
  }
}

// -----------------------------------------------------------------------------
// Twist League DEBUG
// -----------------------------------------------------------------------------
app.get(
  '/api/twist-league/debug',
  (_req, res) => {
    cleanupTwistLeagueQueue();

    return res.json({
      ok: true,
      queuedPlayers: [...twistLeagueQueue.values()].map((entry) => ({
        playerId: entry.playerId,
        username: entry.username,
      })),
      tournaments: [...twistLeagueTournaments.values()].map((tournament) => ({
        id: tournament.id,
        phase: tournament.phase,
        players: tournament.players,
        bracket: getTwistTournamentBracket(tournament),
      })),
      activeMatches: [...twistLeagueMatches.values()].map((match) => ({
        id: match.id,
        tournamentId: match.tournamentId,
        stage: match.stage,
        slot: match.slot,
        phase: match.phase,
        seriesWins: match.seriesWins,
        players: match.players.map((player) => ({
          id: player.id,
          username: player.username,
          ready: player.ready,
          solveTimeMs: player.solveTimeMs,
        })),
      })),
    });
  }
);

// -----------------------------------------------------------------------------
// Twist League JOIN / 4-player lobby
// -----------------------------------------------------------------------------
app.post(
  '/api/twist-league/join',
  (req, res) => {
    cleanupTwistLeagueQueue();

    const playerId = String(
      req.body?.playerId || randomUUID()
    );

    const username = normalizeUsername(
      req.body?.username
    );

    // Already assigned to a current semifinal/final.
    const activeMatch = findActiveTwistMatchByPlayerId(playerId);

    if (activeMatch) {
      const me = activeMatch.players.find(
        (player) => player.id === playerId
      );

      if (me) me.username = username;

      return res.json({
        status: 'matched',
        playerId,
        players: activeMatch.bracket?.joinedPlayers ?? 4,
        capacity: TWIST_PLAYER_CAPACITY,
        match: twistLeagueSnapshot(activeMatch),
      });
    }

    // Player belongs to a tournament but is currently between rounds.
    const tournament = findTwistTournamentByPlayerId(playerId);

    if (tournament) {
      const player = tournament.players.find(
        (entry) => entry.id === playerId
      );

      if (player) player.username = username;

      const nextMatchId =
        player?.finalMatchId ??
        player?.semFinalMatchId ??
        null;

      const nextMatch = nextMatchId
        ? twistLeagueMatches.get(nextMatchId)
        : undefined;

      if (nextMatch) {
        return res.json({
          status: 'matched',
          playerId,
          players: TWIST_PLAYER_CAPACITY,
          capacity: TWIST_PLAYER_CAPACITY,
          match: twistLeagueSnapshot(nextMatch),
        });
      }

      return res.json({
        status: tournament.phase === 'finished' ? 'finished' : 'waiting',
        playerId,
        players: tournament.players.length,
        capacity: TWIST_PLAYER_CAPACITY,
        bracket: getTwistTournamentBracket(tournament),
      });
    }

    // Remove duplicate queue entry from this player.
    for (const [key, entry] of twistLeagueQueue) {
      if (entry.playerId === playerId) {
        twistLeagueQueue.delete(key);
      }
    }

    // Join the 4-player lobby.
    twistLeagueQueue.set(playerId, {
      playerId,
      username,
      joinedAt: Date.now(),
    });

    const entries = [...twistLeagueQueue.values()]
      .slice(0, TWIST_PLAYER_CAPACITY);

    if (entries.length < TWIST_PLAYER_CAPACITY) {
      return res.json({
        status: 'searching',
        playerId,
        players: entries.length,
        capacity: TWIST_PLAYER_CAPACITY,
      });
    }

    // Remove those exact four entries from the lobby.
    for (const entry of entries) {
      twistLeagueQueue.delete(entry.playerId);
    }

    const newTournament = createFourPlayerTwistTournament(entries);
    const myMatch = findActiveTwistMatchByPlayerId(playerId);

    return res.json({
      status: 'matched',
      playerId,
      players: TWIST_PLAYER_CAPACITY,
      capacity: TWIST_PLAYER_CAPACITY,
      match: myMatch
        ? twistLeagueSnapshot(myMatch)
        : null,
      bracket: getTwistTournamentBracket(newTournament),
    });
  }
);

// -----------------------------------------------------------------------------
// Twist League STATE
// -----------------------------------------------------------------------------
app.get(
  '/api/twist-league/state',
  (req, res) => {
    const match = getTwistLeagueMatch(req);

    if (!match) {
      return res.status(404).json({
        error: 'twist league match not found',
      });
    }

    return res.json(
      twistLeagueSnapshot(match)
    );
  }
);

// -----------------------------------------------------------------------------
// Twist League READY
// -----------------------------------------------------------------------------
app.post(
  '/api/twist-league/ready',
  (req, res) => {
    const match = getTwistLeagueMatch(req);
    const playerId = String(
      req.body?.playerId || ''
    );

    const player = match?.players.find(
      (p) => p.id === playerId
    );

    if (!match || !player) {
      return res.status(404).json({
        error: 'twist league match/player not found',
      });
    }

    if (match.phase !== 'ready') {
      return res.status(409).json({
        error: 'match is not ready for READY state',
      });
    }

    player.ready = true;

    return res.json(
      twistLeagueSnapshot(match)
    );
  }
);

// -----------------------------------------------------------------------------
// Twist League START
// -----------------------------------------------------------------------------
app.post(
  '/api/twist-league/start',
  (req, res) => {
    const match = getTwistLeagueMatch(req);
    const playerId = String(
      req.body?.playerId || ''
    );

    const player = match?.players.find(
      (p) => p.id === playerId
    );

    if (!match || !player) {
      return res.status(404).json({
        error: 'twist league match/player not found',
      });
    }

    if (match.players.length !== 2) {
      return res.status(409).json({
        error: 'Twist League match requires exactly 2 players per bracket game',
      });
    }

    if (!match.players.every((p) => p.ready)) {
      return res.status(409).json({
        error: 'both bracket players must be ready',
      });
    }

    if (match.raceStartAt === null) {
      match.raceStartAt = Date.now() + TWIST_START_DELAY_MS;
    }

    return res.json(
      twistLeagueSnapshot(match)
    );
  }
);

// -----------------------------------------------------------------------------
// Twist League SOLVE
// -----------------------------------------------------------------------------
app.post(
  '/api/twist-league/solve',
  (req, res) => {
    const match = getTwistLeagueMatch(req);
    const playerId = String(
      req.body?.playerId || ''
    );

    const player = match?.players.find(
      (p) => p.id === playerId
    );

    if (!match || !player) {
      return res.status(404).json({
        error: 'twist league match/player not found',
      });
    }

    advanceTwistLeagueMatch(match);

    if (
      match.phase !== 'racing' ||
      player.solvedAt !== null
    ) {
      return res.json(
        twistLeagueSnapshot(match)
      );
    }

    const now = Date.now();

    const requestedSolvedAt = Number(
      req.body?.solvedAt
    );

    const requestedElapsedMs = Number(
      req.body?.elapsedMs
    );

    const acceptedSolvedAt = Math.min(
      Number.isFinite(requestedSolvedAt)
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
      Number.isFinite(requestedElapsedMs) &&
      requestedElapsedMs > 0
        ? Math.round(requestedElapsedMs)
        : 0;

    const solveTimeMs = Math.max(
      1,
      clientElapsed > 0
        ? clientElapsed
        : calculated
    );

    // 15-second second-solver window.
    if (
      match.deadlineAt !== null &&
      match.firstSolverId !== player.id &&
      acceptedSolvedAt > match.deadlineAt
    ) {
      const first = match.players.find(
        (p) => p.id === match.firstSolverId
      );

      match.phase = 'finished';
      match.winnerId = first?.id ?? null;
      match.loserId = player.id;

      return res.json(
        twistLeagueSnapshot(match)
      );
    }

    player.startedAt = startAt;
    player.solvedAt = acceptedSolvedAt;
    player.solveTimeMs = solveTimeMs;

    // First solver starts the finish window.
    if (match.firstSolverId === null) {
      match.firstSolverId = player.id;
      match.deadlineAt = acceptedSolvedAt + TWIST_FINISH_WINDOW_MS;

      return res.json(
        twistLeagueSnapshot(match)
      );
    }

    const first = match.players.find(
      (p) => p.id === match.firstSolverId
    );

    if (!first || first.solveTimeMs == null) {
      return res.status(409).json({
        error: 'first solver state is incomplete',
      });
    }

    const second = player;
    const firstTime = first.solveTimeMs;
    const secondTime = second.solveTimeMs;

    const winnerId =
      secondTime < firstTime
        ? second.id
        : first.id;

    const loserId =
      winnerId === second.id
        ? first.id
        : second.id;

    match.winnerId = winnerId;
    match.loserId = loserId;
    match.phase = 'finished';

    // Round/game winner adds one BO3 series win.
    match.seriesWins[winnerId] =
      Number(match.seriesWins[winnerId] || 0) + 1;

    completeTwistSeriesIfNeeded(match);

    return res.json(
      twistLeagueSnapshot(match)
    );
  }
);

// -----------------------------------------------------------------------------
// Twist League TIMEOUT
// -----------------------------------------------------------------------------
app.post(
  '/api/twist-league/timeout',
  (req, res) => {
    const match = getTwistLeagueMatch(req);

    if (!match) {
      return res.status(404).json({
        error: 'twist league match not found',
      });
    }

    advanceTwistLeagueMatch(match);

    if (match.phase === 'finished') {
      return res.json(
        twistLeagueSnapshot(match)
      );
    }

    if (
      match.phase !== 'racing' ||
      !match.firstSolverId ||
      !match.deadlineAt
    ) {
      return res.json(
        twistLeagueSnapshot(match)
      );
    }

    if (Date.now() < match.deadlineAt) {
      return res.json(
        twistLeagueSnapshot(match)
      );
    }

    const first = match.players.find(
      (p) => p.id === match.firstSolverId
    );

    const second = match.players.find(
      (p) => p.id !== match.firstSolverId
    );

    let winnerId = first?.id ?? null;
    let loserId = second?.id ?? null;

    if (second?.solvedAt !== null) {
      const firstTime =
        first?.solveTimeMs ?? Number.POSITIVE_INFINITY;
      const secondTime =
        second?.solveTimeMs ?? Number.POSITIVE_INFINITY;

      winnerId =
        secondTime < firstTime
          ? second.id
          : first?.id ?? null;

      loserId =
        secondTime < firstTime
          ? first?.id ?? null
          : second.id;
    }

    match.phase = 'finished';
    match.winnerId = winnerId;
    match.loserId = loserId;

    if (winnerId) {
      match.seriesWins[winnerId] =
        Number(match.seriesWins[winnerId] || 0) + 1;
    }

    completeTwistSeriesIfNeeded(match);

    return res.json(
      twistLeagueSnapshot(match)
    );
  }
);

// -----------------------------------------------------------------------------
// Twist League NEXT GAME
// Same match ID within a semifinal/final series.
// -----------------------------------------------------------------------------
app.post(
  '/api/twist-league/next-game',
  (req, res) => {
    const match = getTwistLeagueMatch(req);
    const playerId = String(
      req.body?.playerId || ''
    );

    if (!match) {
      return res.status(404).json({
        error: 'twist league match not found',
      });
    }

    const player = match.players.find(
      (p) => p.id === playerId
    );

    if (!player) {
      return res.status(403).json({
        error: 'player is not part of this match',
      });
    }

    // Series already complete: return the final snapshot.
    if (match.seriesWinnerId) {
      return res.json(
        twistLeagueSnapshot(match)
      );
    }

    // Both phones may call this after a completed game.
    if (
      match.phase === 'ready' &&
      match.raceStartAt === null &&
      match.firstSolverId === null &&
      match.deadlineAt === null &&
      match.winnerId === null &&
      match.loserId === null &&
      match.players.every(
        (p) =>
          p.ready === false &&
          p.startedAt === null &&
          p.solvedAt === null &&
          p.solveTimeMs === null
      )
    ) {
      return res.json(
        twistLeagueSnapshot(match)
      );
    }

    if (match.phase !== 'finished') {
      return res.status(409).json({
        error: 'current game is not finished',
      });
    }

    // A winner who already clinched the BO3 should not be reset.
    if (match.seriesWinnerId) {
      return res.json(
        twistLeagueSnapshot(match)
      );
    }

    match.gameNumber += 1;
    resetTwistGame(match);

    return res.json(
      twistLeagueSnapshot(match)
    );
  }
);

// -----------------------------------------------------------------------------
// Twist League LEAVE
// -----------------------------------------------------------------------------
app.post(
  '/api/twist-league/leave',
  (req, res) => {
    const playerId = String(
      req.body?.playerId || ''
    );

    twistLeagueQueue.delete(playerId);

    for (const [tournamentId, tournament] of twistLeagueTournaments) {
      const player = tournament.players.find(
        (entry) => entry.id === playerId
      );

      if (!player) continue;

      // Mark the player as having left, but keep the tournament record so
      // the remaining bracket state is inspectable during development.
      player.status = 'left';

      // If this player has an active game, remove the game match.
      for (const [matchId, match] of twistLeagueMatches) {
        if (
          match.tournamentId === tournamentId &&
          match.phase !== 'finished' &&
          match.players.some((p) => p.id === playerId)
        ) {
          twistLeagueMatches.delete(matchId);
        }
      }

      break;
    }

    return res.json({ ok: true });
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
