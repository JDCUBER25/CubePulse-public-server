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
// Completely isolated from Tournament matchmaking.
// -----------------------------------------------------------------------------
const twistLeagueQueue =
  new Map();

const twistLeagueMatches =
  new Map();

const TWIST_QUEUE_TTL_MS =
  15000;

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

function findActiveTwistMatchByPlayerId(
  playerId
) {
  return findActiveMatchByPlayerId(
    playerId,
    twistLeagueMatches
  );
}

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

function twistLeagueSnapshot(
  match
) {
  advanceTwistLeagueMatch(
    match
  );

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
// Twist League DEBUG
// -----------------------------------------------------------------------------
app.get(
  '/api/twist-league/debug',
  (_req, res) => {
    res.json({
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

      activeMatches:
        [
          ...twistLeagueMatches.values()
        ].map(
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
// Twist League JOIN
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

    const existing =
      findActiveTwistMatchByPlayerId(
        playerId
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

        players: 2,

        capacity: 2,

        match:
          twistLeagueSnapshot(
            existing
          ),
      });
    }

    for (
      const [
        key,
        entry
      ] of twistLeagueQueue
    ) {
      if (
        entry.playerId ===
        playerId
      ) {
        twistLeagueQueue.delete(
          key
        );
      }
    }

    const opponent =
      [
        ...twistLeagueQueue.entries()
      ].find(
        ([, entry]) =>
          entry.playerId !==
          playerId
      );

    if (!opponent) {
      twistLeagueQueue.set(
        playerId,
        {
          playerId,
          username,
          joinedAt:
            Date.now(),
        }
      );

      return res.json({
        status:
          'searching',

        playerId,

        players: 1,

        capacity: 2,
      });
    }

    twistLeagueQueue.delete(
      opponent[0]
    );

    const match = {
      id:
        randomUUID(),

      format:
        'BO3',

      capacity: 2,

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

    twistLeagueMatches.set(
      match.id,
      match
    );

    return res.json({
      status:
        'matched',

      playerId,

      players: 2,

      capacity: 2,

      match:
        twistLeagueSnapshot(
          match
        ),
    });
  }
);

// -----------------------------------------------------------------------------
// Twist League STATE
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
// Twist League READY
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
// Twist League START
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
            'twist league requires exactly 2 players',
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
            'both Twist League players must be ready',
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
      twistLeagueSnapshot(
        match
      )
    );
  }
);

// -----------------------------------------------------------------------------
// Twist League SOLVE
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
        15000;

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
      twistLeagueSnapshot(
        match
      )
    );
  }
);

// -----------------------------------------------------------------------------
// Twist League TIMEOUT
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
        twistLeagueSnapshot(
          match
        )
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
      twistLeagueSnapshot(
        match
      )
    );
  }
);

// -----------------------------------------------------------------------------
// Twist League LEAVE
// -----------------------------------------------------------------------------
app.post(
  '/api/twist-league/leave',
  (req, res) => {
    const playerId =
      String(
        req.body?.playerId ||
          ''
      );

    twistLeagueQueue.delete(
      playerId
    );

    for (
      const [
        matchId,
        match,
      ] of twistLeagueMatches
    ) {
      if (
        match.phase !==
          'finished' &&
        match.players.some(
          (p) =>
            p.id ===
            playerId
        )
      ) {
        twistLeagueMatches.delete(
          matchId
        );

        break;
      }
    }

    return res.json({
      ok: true,
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
