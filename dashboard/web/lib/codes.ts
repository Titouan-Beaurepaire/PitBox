// Signification des codes défaut OBD-II génériques les plus courants (norme SAE J2012).
// Les codes en P1xxx sont propres au constructeur : seul un outil Peugeot les explique.
const DESCRIPTIONS: Record<string, string> = {
  P0100: "Débitmètre d'air : circuit",
  P0101: "Débitmètre d'air : valeur incohérente",
  P0113: "Sonde de température d'air d'admission : signal haut",
  P0115: "Sonde de température moteur : circuit",
  P0128: "Thermostat : température moteur trop basse",
  P0130: "Sonde lambda amont : circuit",
  P0171: "Mélange trop pauvre",
  P0172: "Mélange trop riche",
  P0201: "Injecteur cylindre 1 : circuit",
  P0234: "Suralimentation trop forte",
  P0299: "Suralimentation insuffisante",
  P0300: "Ratés d'allumage aléatoires",
  P0301: "Ratés d'allumage cylindre 1",
  P0302: "Ratés d'allumage cylindre 2",
  P0303: "Ratés d'allumage cylindre 3",
  P0304: "Ratés d'allumage cylindre 4",
  P0335: "Capteur de vilebrequin : circuit",
  P0340: "Capteur d'arbre à cames : circuit",
  P0400: "Recirculation des gaz (EGR) : débit",
  P0420: "Catalyseur : efficacité insuffisante",
  P0441: "Purge du canister : débit incorrect",
  P0500: "Capteur de vitesse du véhicule",
  P0562: "Tension du réseau de bord trop basse",
  P0563: "Tension du réseau de bord trop haute",
  P0606: "Calculateur moteur : défaut interne",
  P2002: "Filtre à particules : efficacité insuffisante",
};

export function descriptionCode(code: string): string {
  if (DESCRIPTIONS[code]) return DESCRIPTIONS[code];
  if (/^P1/.test(code)) return "Code propre au constructeur";
  return { P: "Groupe motopropulseur", C: "Châssis", B: "Carrosserie", U: "Réseau de communication" }[code[0]] ?? "";
}
