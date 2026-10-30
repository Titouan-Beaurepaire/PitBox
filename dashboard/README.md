# PitLabs Telemetry — serveur et dashboard de PitBox

```
R4 WiFi ))) partage de connexion / 4G ))) Caddy ─┬─ /ws, /api ──> server (FastAPI + SQLite)
                                                 └─ le reste ───> web (Next.js : Live, Sessions, Journal, Dash)
```

- **server/** : reçoit les trames de la R4 sur `/ws/ingest`, les range par session, les diffuse en direct
  sur `/ws/live`, importe les journaux SD et exporte en CSV.
- **web/** : page Journal (tout ce qui s'est passé, en direct), page Live (tuiles et courbes des 60 dernières secondes), analyse des sessions, et Dash :
  tableau de bord embarqué pour téléphone (`/dash`, shift light, alertes, plein écran).
- **server/simulateur_r4.py** : joue le rôle de la R4 (trames de la simulation, pertes, coupures).
  Un seul émetteur à la fois : le serveur suit une seule voiture.

## Sessions

Une session commence à chaque démarrage de la R4 (son numéro de trame repart de 0), ou après
10 minutes sans trame. Le live est incomplet (trames perdues en 4G) : importer le fichier `SESSxxx.CSV`
de la carte SD dans la page de la session remplace le live par le journal complet.

## Journal

Tout ce qui se passe est noté dans la table `evenements`, affiché sur `/journal` (en direct, filtrable)
et écrit dans la sortie du conteneur (`docker compose logs -f server`) :

- **r4** : ce que la R4 envoie elle-même (`#E,t_ms,CODE,detail*CK`) — démarrage (simulation, CAN, carte SD),
  WiFi trouvé / perdu, serveur retrouvé (durée de la coupure, trames écrasées), voiture muette,
  erreur CAN ou SD, et `ENVOI_REFUSE` si quelque chose a tenté d'écrire dans la voiture.
  La R4 garde aussi ces événements dans `EVENTS.CSV` sur la carte SD.
- **voiture** : déduit des mesures — voyant moteur allumé / éteint, codes défaut apparus / disparus,
  température (chaud, surchauffe), batterie (alternateur qui ne charge plus, batterie faible, surtension).
- **serveur** : R4 connectée / déconnectée, jeton refusé, nouvelle session et pourquoi, trames illisibles
  ou manquantes (bilan par minute), import SD, suppression de session, sauvegardes.

## Sauvegardes

Le serveur copie la base toutes les 6 h dans `sauvegardes/` (sur le VPS, à côté du `docker-compose.yml`),
compressée, et garde les 40 dernières (10 jours). Réglable dans `.env`. À la main :

```bash
docker compose exec server python -m app.sauvegarde
```

Restaurer : arrêter le serveur, remplacer la base (et effacer son journal WAL, sinon il serait
rejoué par-dessus), relancer.

```bash
docker compose stop server
docker compose run --rm --entrypoint sh server -c 'rm -f /data/pitbox.db-wal /data/pitbox.db-shm &&
  python -c "import gzip, shutil, sys; shutil.copyfileobj(gzip.open(sys.argv[1]), open(\"/data/pitbox.db\", \"wb\"))" \
  /sauvegardes/pitbox-AAAAMMJJ-HHMMSS.db.gz'
docker compose start server
```

Ces copies protègent d'une erreur (session supprimée, base abîmée), pas de la perte du VPS : pour ça,
les rapatrier de temps en temps sur le PC (`scp -r ubuntu@IP_DU_VPS:pitbox/sauvegardes .`).

## Développement

```bash
cd server && uv venv .venv && uv pip install -p .venv -r requirements.txt
PITBOX_TOKEN=dev .venv/bin/uvicorn app.main:app --port 8000 --reload
.venv/bin/python simulateur_r4.py            # dans un autre terminal

cd web && npm install && npm run dev          # http://localhost:3000
```

## Déploiement sur le VPS (Ubuntu)

```bash
# une fois : Docker
curl -fsSL https://get.docker.com | sh

# copier le dossier dashboard sur le VPS, puis dedans :
cp .env.example .env        # et y mettre un vrai jeton : openssl rand -hex 24
docker compose up -d --build
```

Le dashboard est alors sur `http://IP_DU_VPS` et le Dash sur `http://IP_DU_VPS/dash`
(ports 80 et 443 à ouvrir dans le pare-feu).

**HTTPS sans nom de domaine** : mettre `PITBOX_ADRESSE=51-75-12-34.sslip.io` (l'IP du VPS avec des tirets)
dans `.env`. sslip.io fait pointer ce nom vers l'IP, et Caddy obtient tout seul un certificat Let's Encrypt.
Le dashboard passe en `https://51-75-12-34.sslip.io` et la R4 en `wss://` (`SERVEUR_TLS 1`, port 443).

Tester le serveur déployé sans matériel :

```bash
python server/simulateur_r4.py ws://IP_DU_VPS/ws/ingest LE_JETON --duree 60
```

## Côté R4

`firmware/r4_can/reseau.ino` : la R4 se connecte au WiFi (`arduino_secrets.h`), ouvre un WebSocket vers
`ws://SERVEUR_HOTE:SERVEUR_PORT/ws/ingest?token=SECRET_JETON` et envoie ses trames telles quelles
(`$seq,t_ms,regime,temp,vitesse,charge,papillon,etat,voyant,defauts,tension*CK`) par paquets de 250 ms,
séparées par des retours à la ligne, plus les codes défaut toutes les 5 s et dès qu'ils changent
(`#D,P0301,P0420*CK`) et ses événements (`#E,t_ms,CODE,detail*CK`). Le serveur vérifie la somme de contrôle et ignore les doublons.
