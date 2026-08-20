# CubePulse Public Matchmaking Server

Standalone public HTTP matchmaking server for the CubePulse Tournament MVP.

## Render
Create a new Web Service from this folder/repository.
- Build: `npm install`
- Start: `npm start`
- Health: `/api/health`

After deployment, use the public Render URL as:
`EXPO_PUBLIC_API_BASE_URL=https://<your-service>.onrender.com`

The server is intentionally in-memory for the current MVP. A restart clears waiting players and active matches.
