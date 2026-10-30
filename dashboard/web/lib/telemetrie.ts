// Types et seuils partagés par les pages du dashboard

export type Mesure = {
  session: number;
  seq: number;
  t_ms: number;
  regime: number | null;
  temp: number | null;
  vitesse: number | null;
  charge: number | null;
  papillon: number | null;
  etat: number;
  voyant: number | null;  // voyant moteur de la voiture : 1 = allumé
  defauts: number | null; // nombre de codes défaut enregistrés
  tension: number | null; // dixièmes de volt
};

export type Session = {
  id: number;
  debut: number; // epoch, s
  fin: number;
  seq_min: number | null;
  seq_max: number | null;
  nb_live: number;
  nb_sd: number;
  trames_perdues: number;
  defauts_vus: string; // codes apparus pendant la session, séparés par des virgules
};

export type Evenement = {
  id: number;
  t: number; // epoch, s (heure du serveur)
  niveau: "info" | "attention" | "alerte";
  source: "r4" | "voiture" | "serveur";
  code: string;
  message: string;
  session_id: number | null;
  t_ms: number | null; // horloge de la R4
};

export type Colonnes = {
  source: "live" | "sd";
  t_ms: number[];
  regime: (number | null)[];
  temp: (number | null)[];
  vitesse: (number | null)[];
  charge: (number | null)[];
  papillon: (number | null)[];
  etat: number[];
  voyant: (number | null)[];
  defauts: (number | null)[];
  tension: (number | null)[];
};

// Mêmes seuils que les LEDs de la Nano
export const REGIME_SHIFT = 6000;
export const REGIME_RETRO = 2000;
export const REGIME_RALENTI = 1100;
export const REGIME_MAX = 7500;
export const TEMP_FROID = 70;
export const TEMP_MINEUR = 105;
export const TEMP_MAJEUR = 115;

export const TENSION_CHARGE_MIN = 130; // dixièmes de V : en dessous, l'alternateur ne charge plus
export const TENSION_MAX = 150;
export const TENSION_BATTERIE_FAIBLE = 118; // moteur arrêté

export const ETATS = ["Pas de données", "OK", "Erreur CAN"] as const;

export const COULEURS = {
  regime: "#ff4d4d",
  papillon: "#31d07a",
  charge: "#ffc23d",
  vitesse: "#3ba7ff",
  temp: "#ff8a3d",
  tension: "#b46cff",
};

export function urlLive(): string {
  if (process.env.NEXT_PUBLIC_WS_URL) return process.env.NEXT_PUBLIC_WS_URL;
  const { protocol, hostname, host, port } = window.location;
  if (port === "3000") return `ws://${hostname}:8000/ws/live`; // next dev : FastAPI tourne à côté
  return `${protocol === "https:" ? "wss" : "ws"}://${host}/ws/live`;
}

export function niveauTemp(temp: number | null): { texte: string; classe: string } {
  if (temp === null) return { texte: "—", classe: "" };
  if (temp >= TEMP_MAJEUR) return { texte: "Surchauffe", classe: "alerte" };
  if (temp >= TEMP_MINEUR) return { texte: "Chaud", classe: "attention" };
  if (temp < TEMP_FROID) return { texte: "Moteur froid", classe: "froid" };
  return { texte: "Normale", classe: "ok" };
}

export function dateHeure(epoch: number): string {
  return new Date(epoch * 1000).toLocaleString("fr-FR", { dateStyle: "medium", timeStyle: "short" });
}

export function duree(secondes: number): string {
  const m = Math.floor(secondes / 60);
  const s = Math.round(secondes % 60);
  return m ? `${m} min ${s.toString().padStart(2, "0")} s` : `${s} s`;
}

// Voyant batterie reconstitué à partir de la tension (la 208 ne transmet pas le sien en OBD standard)
export function alerteBatterie(tension: number | null, regime: number | null): string | null {
  if (tension === null) return null;
  const moteurTourne = regime !== null && regime > 500;
  if (tension > TENSION_MAX) return "Surtension";
  if (moteurTourne && tension < TENSION_CHARGE_MIN) return "Pas de charge";
  if (!moteurTourne && tension < TENSION_BATTERIE_FAIBLE) return "Batterie faible";
  return null;
}

export const volts = (tension: number | null) => (tension === null ? "—" : (tension / 10).toFixed(1));
