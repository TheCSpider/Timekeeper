# Timekeeper

A Dockerized screen-time tracking web app for families. Users earn time by completing chores; admins manage chores, approve completions, and configure weekly rules.

## Quick Start

```bash
docker compose up --build
```

Open **http://localhost:3000** in your browser.

### Default credentials

| Role  | Username | Password  |
|-------|----------|-----------|
| Admin | `admin`  | `admin123`|
| User  | `user1`  | `user123` |

> Change these immediately in production via the Admin → Create User panel.

---

## Features

### User
- View time balance (live countdown during an active session)
- Start/stop screen-time sessions — tap **Start Now** or enter a specific time
- Complete chores to earn time
- Track this week's mandatory chore progress
- See completion history with approval status

### Admin
- **Dashboard** — see all users' balances and mandatory-chore progress; award time; unblock spending
- **Chores** — add/edit chores, toggle mandatory status per-week with a toggle switch
- **Pending** — approve or reject chores that require validation
- **Settings** — set Sunday allowance amount and how many mandatory chores are required each week

---

## Chore types

| Type | How it works |
|------|-------------|
| **Doing** | Fixed minutes earned when completed (0 = mandatory-only) |
| **Time-based** | User logs duration; earns `duration × ratio` minutes |

Any chore can be flagged mandatory. Mandatory chores earn **0 time** — they're requirements, not rewards.

---

## Weekly rules

- **Sunday** — allowance is automatically paid to every user
- Mandatory chores reset each week (inherited from the previous week's configuration)
- If a user fails to complete the required mandatory chores in week N, spending is **blocked** in week N+1
- An admin can unblock any user at any time from the Dashboard tab

---

## Production notes

- Set a strong `JWT_SECRET` via an environment variable or `.env` file (see `.env.example`)
- Change default passwords after first login via Admin → Settings → Create User
- The PostgreSQL data is persisted in the `postgres_data` Docker volume
- The app is self-bootstrapping — it creates and migrates the database schema on every startup, so no manual SQL setup is required

---

## Deploying to Portainer

Portainer can deploy this app in two ways. **Option A** (Repository) is the easiest — Portainer clones the repo and builds the image on the host. **Option B** (Web editor) is better for air-gapped environments or when you want to separate build from deploy.

### Prerequisites

- Portainer CE or BE running and accessible
- The repository pushed to GitHub (or another git host Portainer can reach)
- A strong secret ready to use as `JWT_SECRET` — generate one with:
  ```bash
  openssl rand -hex 32
  ```

---

### Option A — Repository stack (Portainer builds from GitHub)

This is the recommended path. Portainer clones the repo, reads `docker-compose.yml`, and builds the image directly on the Docker host.

**1. Open Portainer and go to your environment**

Select the environment (local or remote) you want to deploy to.

**2. Create a new stack**

Navigate to **Stacks** → **Add stack**.

**3. Choose the Repository build method**

Select **Repository** from the build method tabs at the top of the form.

**4. Enter the repository details**

| Field | Value |
|-------|-------|
| Repository URL | `https://github.com/your-username/timekeeper` |
| Repository reference | `refs/heads/main` (or your branch) |
| Compose path | `docker-compose.yml` |

If the repository is private, enable **Authentication** and provide a GitHub personal access token with `repo` read scope.

**5. Set environment variables**

Scroll down to the **Environment variables** section and add:

| Variable | Value |
|----------|-------|
| `JWT_SECRET` | *(your generated secret)* |
| `POSTGRES_PASSWORD` | *(a strong password — optional, defaults to `timekeeper_pass`)* |
| `PORT` | `3000` *(optional, change if 3000 is already in use on the host)* |

> `JWT_SECRET` is **required** — the stack will refuse to start if it is missing.

**6. Enable automatic updates (optional)**

Turn on **GitOps updates** (Portainer BE) or set a polling interval if you want the stack to redeploy automatically when you push to the repository.

**7. Deploy the stack**

Click **Deploy the stack**. Portainer will clone the repository, build the `app` image, pull `postgres:15-alpine`, and start both containers. This takes a minute or two on first run.

**8. Access the app**

Open `http://<your-portainer-host>:3000` in a browser. Log in with the default credentials:

| Role  | Username | Password  |
|-------|----------|-----------|
| Admin | `admin`  | `admin123`|
| User  | `user1`  | `user123` |

Change both passwords immediately via Admin → Settings → Create User.

---

### Option B — Web editor with a pre-built image

Use this approach when you want to build once and deploy many times, or when the Portainer host cannot reach GitHub.

**1. Build and push the image**

Run this on a machine that has Docker and access to your image registry:

```bash
# Docker Hub
docker build -t your-dockerhub-username/timekeeper:latest .
docker push your-dockerhub-username/timekeeper:latest

# GitHub Container Registry
docker build -t ghcr.io/your-github-username/timekeeper:latest .
docker push ghcr.io/your-github-username/timekeeper:latest
```

**2. Create a modified compose snippet**

Take the contents of `docker-compose.yml`, remove the `build: .` line from the `app` service, and replace it with your image reference:

```yaml
  app:
    image: ghcr.io/your-github-username/timekeeper:latest
    restart: unless-stopped
    ...
```

**3. Create a new stack in Portainer**

Navigate to **Stacks** → **Add stack**. Select **Web editor** and paste the modified compose content into the editor.

**4. Set environment variables**

Add the same variables as Option A (`JWT_SECRET`, and optionally `POSTGRES_PASSWORD` and `PORT`) in the **Environment variables** section below the editor.

**5. Deploy and access**

Click **Deploy the stack**, then open `http://<your-portainer-host>:3000`.

---

### Updating to a new version

**Option A (Repository):** Push your changes to the repository branch. If GitOps polling is enabled, Portainer redeploys automatically. Otherwise, open the stack in Portainer and click **Pull and redeploy**.

**Option B (Registry):** Build and push a new image tag, then open the stack in Portainer, update the image tag if needed, and click **Update the stack**.

In both cases the database schema is updated automatically on startup — no manual migration steps are required.

---

### Persistent data

The PostgreSQL data lives in a Docker named volume (`postgres_data`). It persists across stack updates and container restarts. To back it up, use standard Docker volume backup techniques or Portainer's volume browser.
