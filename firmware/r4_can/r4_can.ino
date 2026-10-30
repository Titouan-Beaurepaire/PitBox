// ===================================================
//  PitBox — R4 : acquisition OBD-II, enregistrement SD, envoi à la Nano et au serveur
//  Titouan Beaurepaire
//  Shield : Seeed CAN-BUS Shield V2.0
// ===================================================
#include <SPI.h>
#include <SD.h>
#include <mcp_can.h>

#define SIMULATION 1   // 1 = données simulées, 0 = vraie voiture
#define TELEMETRIE 1   // 1 = envoi au serveur PitLabs par WiFi (voir reseau.ino)

// --- CAN Bus Shield ---
const int CAN_CS  = 9;          // 10 si "Etat: 2"
const int CAN_INT = 2;
#define CAN_QUARTZ MCP_16MHZ
MCP_CAN CAN(CAN_CS);

// --- Carte SD (lecteur du shield) ---
const int SD_CS = 4;

// --- OBD-II ---
const unsigned long OBD_ID_REQUETE = 0x7DF;
const unsigned long OBD_ID_MIN     = 0x7E8;
const unsigned long OBD_ID_MAX     = 0x7EF;
const unsigned long OBD_ID_ECU_MIN = 0x7E0;   // identifiants physiques des calculateurs (réponse - 8)
const unsigned long OBD_ID_ECU_MAX = 0x7E7;
const byte MODE_DONNEES = 0x01;
const byte MODE_DEFAUTS = 0x03;   // codes défaut enregistrés
const byte PID_STATUT   = 0x01;   // voyant moteur + nombre de codes défaut
const byte PID_CHARGE   = 0x04;
const byte PID_TEMP     = 0x05;
const byte PID_REGIME   = 0x0C;
const byte PID_VITESSE  = 0x0D;
const byte PID_PAPILLON = 0x11;
const byte PID_TENSION  = 0x42;   // tension du calculateur ≈ tension batterie

// Régime une requête sur deux, les autres PIDs à tour de rôle
const byte PIDS_SECONDAIRES[] = { PID_VITESSE, PID_PAPILLON, PID_CHARGE, PID_TEMP, PID_STATUT, PID_TENSION };
const byte NB_SECONDAIRES = sizeof(PIDS_SECONDAIRES);

// --- Timing ---
const unsigned long PERIODE_REQUETE = 50;    // ms
const unsigned long PERIODE_TRAME   = 100;   // ms : envoi vers la Nano et le serveur
const unsigned long PERIODE_LOG     = 50;    // ms : une ligne sur la carte SD
const unsigned long PERIODE_FLUSH   = 1000;  // ms : écriture effective sur la carte
const unsigned long TIMEOUT_ECU     = 1000;  // ms sans réponse = pas de données
const unsigned long PERIODE_REINIT  = 2000;  // ms entre deux tentatives d'init CAN
const unsigned long PERIODE_DEFAUTS = 10000; // ms entre deux lectures des codes défaut
const unsigned long PERIODE_CODES   = 5000;  // ms : rappel des codes au serveur

// --- États envoyés à la Nano ---
const int ETAT_PAS_DE_DONNEES = 0;
const int ETAT_OK             = 1;
const int ETAT_ERREUR_CAN     = 2;
const char* NOMS_ETATS[] = { "aucune donnee de la voiture", "donnees OK", "erreur du shield CAN" };
int dernierEtat = -1;
const int TAILLE_EVENEMENT = 104;

// --- Données ---
const int INCONNU = -100;   // jamais reçue (hors de la plage de tous les PIDs)
int regime = INCONNU;
int temp = INCONNU;
int vitesse = INCONNU;
int charge = INCONNU;
int papillon = INCONNU;
int voyant = INCONNU;       // voyant moteur : 1 = allumé
int nbDefauts = INCONNU;    // codes défaut enregistrés dans l'ECU
int tension = INCONNU;      // en dixièmes de volt
bool canOk = false;
unsigned long derniereReponse = 0;
unsigned long derniereRequete = 0;
unsigned long derniereTrame = 0;
unsigned long derniereInit = 0;
byte compteurRequetes = 0;
unsigned long sequence = 0;

// --- Codes défaut (ex. "P0301") ---
const byte MAX_CODES = 8;
char codes[MAX_CODES][6];
byte nbCodes = 0;
unsigned long derniereLectureDefauts = 0;
unsigned long derniersCodes = 0;

// --- Réponse longue en plusieurs trames CAN (ISO-TP), utilisée par la lecture des codes ---
byte messageLong[64];
int tailleMessageLong = 0;
int recuMessageLong = 0;

// --- Enregistrement ---
File journal;
bool sdOk = false;
char nomJournal[13] = "aucun";
unsigned long dernierLog = 0;
unsigned long dernierFlush = 0;

// ---------------------------------------------------

void initialiserCan() {
  derniereInit = millis();
  bool avant = canOk;
  canOk = CAN.begin(MCP_ANY, CAN_500KBPS, CAN_QUARTZ) == CAN_OK;
  if (canOk) CAN.setMode(MCP_NORMAL);
  if (canOk && !avant && millis() > PERIODE_REINIT) noterEvenement("CAN_OK", "shield CAN de nouveau disponible");
}

// Un fichier par session : SESS000.CSV, SESS001.CSV, ...
void ouvrirJournal() {
  if (!SD.begin(SD_CS)) return;
  char nom[13];
  for (int i = 0; i < 1000; i++) {
    snprintf(nom, sizeof(nom), "SESS%03d.CSV", i);
    if (SD.exists(nom)) continue;
    journal = SD.open(nom, FILE_WRITE);
    if (!journal) return;
    journal.println("t_ms,regime,temp,vitesse,charge,papillon,etat,voyant,defauts,tension");
    sdOk = true;
    strcpy(nomJournal, nom);
    return;
  }
}

// ---------------------------------------------------
//  Sécurité : la R4 ne fait que LIRE la voiture.
//  Tout ce qui part sur le bus CAN passe par ici, et seules trois trames sont autorisées :
//   - demande de donnée (mode 01) et des codes défaut enregistrés (mode 03), vers 0x7DF ;
//   - accord de contrôle de flux ISO-TP (0x30), vers un calculateur qui nous répond.
//  Effacer les codes (mode 04), écrire (0x2E), piloter (0x2F, 0x31)... est refusé.
// ---------------------------------------------------
bool trameAutorisee(unsigned long id, const byte* data) {
  bool demande = id == OBD_ID_REQUETE && data[0] >= 1 && data[0] <= 2 &&
                 (data[1] == MODE_DONNEES || data[1] == MODE_DEFAUTS);
  bool accord = id >= OBD_ID_ECU_MIN && id <= OBD_ID_ECU_MAX && data[0] == 0x30;
  return demande || accord;
}

void envoyerSurBus(unsigned long id, byte* data) {
  if (!trameAutorisee(id, data)) {
    char detail[48];
    snprintf(detail, sizeof(detail), "id %03lX, %02X %02X %02X : bloquee", id, data[0], data[1], data[2]);
    noterEvenement("ENVOI_REFUSE", detail);
    return;
  }
  CAN.sendMsgBuf(id, 0, 8, data);
}

void envoyerRequete(byte pid) {
  byte data[8] = { 0x02, MODE_DONNEES, pid, 0x55, 0x55, 0x55, 0x55, 0x55 };
  envoyerSurBus(OBD_ID_REQUETE, data);
}

void demanderDefauts() {
  byte data[8] = { 0x01, MODE_DEFAUTS, 0x55, 0x55, 0x55, 0x55, 0x55, 0x55 };
  envoyerSurBus(OBD_ID_REQUETE, data);
}

void planifierRequetes() {
  if (millis() - derniereRequete < PERIODE_REQUETE) return;
  derniereRequete = millis();
  if (nbDefauts > 0 && millis() - derniereLectureDefauts >= PERIODE_DEFAUTS) {
    derniereLectureDefauts = millis();
    demanderDefauts();
    return;
  }
  if (nbDefauts == 0) nbCodes = 0;
  byte pid = compteurRequetes % 2 == 0 ? PID_REGIME : PIDS_SECONDAIRES[compteurRequetes / 2];
  envoyerRequete(pid);
  compteurRequetes = (compteurRequetes + 1) % (2 * NB_SECONDAIRES);
}

void lireReponses() {
  while (CAN.checkReceive() == CAN_MSGAVAIL) {
    unsigned long id;
    byte len;
    byte buf[8];
    CAN.readMsgBuf(&id, &len, buf);

    if (id < OBD_ID_MIN || id > OBD_ID_MAX) continue;
    if (lireMessageLong(id, buf)) continue;
    if (buf[1] == MODE_DEFAUTS + 0x40 && buf[0] <= 7) {   // codes défaut en une seule trame
      traiterDefauts(buf + 1, buf[0]);
      continue;
    }
    if (len < 4 || buf[1] != MODE_DONNEES + 0x40) continue;

    switch (buf[2]) {
      case PID_REGIME:
        if (len < 5) continue;
        regime = ((uint16_t)buf[3] << 8 | buf[4]) / 4;
        break;
      case PID_TEMP:     temp = buf[3] - 40;          break;
      case PID_VITESSE:  vitesse = buf[3];            break;
      case PID_CHARGE:   charge = buf[3] * 100 / 255; break;
      case PID_PAPILLON: papillon = buf[3] * 100 / 255; break;
      case PID_STATUT:
        voyant = buf[3] >> 7;
        nbDefauts = buf[3] & 0x7F;
        break;
      case PID_TENSION:
        if (len < 5) continue;
        tension = ((uint16_t)buf[3] << 8 | buf[4]) / 100;   // mV → dixièmes de volt
        break;
      default: continue;
    }
    derniereReponse = millis();
  }
}

// Plus de 2 codes ne tiennent pas dans une trame CAN : l'ECU envoie une première trame,
// attend notre accord (contrôle de flux), puis envoie la suite
bool lireMessageLong(unsigned long id, byte* buf) {
  byte type = buf[0] >> 4;
  if (type == 1) {
    tailleMessageLong = min(((buf[0] & 0x0F) << 8) | buf[1], (int)sizeof(messageLong));
    memcpy(messageLong, buf + 2, 6);
    recuMessageLong = 6;
    byte accord[8] = { 0x30, 0x00, 0x00, 0x55, 0x55, 0x55, 0x55, 0x55 };
    envoyerSurBus(id - 8, accord);   // l'ECU écoute sur son identifiant de réponse - 8
    return true;
  }
  if (type == 2 && recuMessageLong > 0) {
    int n = min(7, tailleMessageLong - recuMessageLong);
    memcpy(messageLong + recuMessageLong, buf + 1, n);
    recuMessageLong += n;
    if (recuMessageLong >= tailleMessageLong) {
      if (messageLong[0] == MODE_DEFAUTS + 0x40) traiterDefauts(messageLong, tailleMessageLong);
      recuMessageLong = 0;
    }
    return true;
  }
  return false;
}

// Réponse : 0x43, nombre de codes, puis 2 octets par code
// 2 premiers bits : P (moteur), C (châssis), B (carrosserie), U (réseau) ; le reste en hexadécimal
void traiterDefauts(const byte* m, int taille) {
  nbCodes = 0;
  for (int i = 2; i + 1 < taille && nbCodes < MAX_CODES; i += 2) {
    if (m[i] == 0 && m[i + 1] == 0) continue;
    snprintf(codes[nbCodes++], sizeof(codes[0]), "%c%d%X%X%X",
             "PCBU"[m[i] >> 6], (m[i] >> 4) & 3, m[i] & 0xF, m[i + 1] >> 4, m[i + 1] & 0xF);
  }
  derniersCodes = 0;   // à transmettre tout de suite
}

int calculerEtat() {
  if (!canOk) return ETAT_ERREUR_CAN;
  bool ecuActif = derniereReponse != 0 && millis() - derniereReponse < TIMEOUT_ECU;
  if (ecuActif && regime != INCONNU && temp != INCONNU) return ETAT_OK;
  return ETAT_PAS_DE_DONNEES;
}

void enregistrer() {
  if (!sdOk || millis() - dernierLog < PERIODE_LOG) return;
  dernierLog = millis();

  char ligne[96];
  snprintf(ligne, sizeof(ligne), "%lu,%d,%d,%d,%d,%d,%d,%d,%d,%d",
           dernierLog, regime, temp, vitesse, charge, papillon, calculerEtat(), voyant, nbDefauts, tension);
  if (journal.println(ligne) == 0) {
    sdOk = false;
    noterEvenement("SD_ERREUR", "ecriture impossible, carte retiree ?");
    return;
  }

  if (millis() - dernierFlush >= PERIODE_FLUSH) {
    dernierFlush = millis();
    journal.flush();
  }
}

// Ce qui arrive à la R4 (démarrage, WiFi, CAN...) : sur l'USB, dans EVENTS.CSV et au serveur
// Ligne envoyée : #E,t_ms,CODE,detail*CK
void noterEvenement(const char* code, const char* detail) {
  char corps[TAILLE_EVENEMENT - 8];
  snprintf(corps, sizeof(corps), "E,%lu,%s,%s", millis(), code, detail);
  for (char* c = corps + 2; *c; c++) if (*c == '*' || *c == '\n') *c = ' ';   // garde la ligne lisible
  Serial.print("Evenement : ");
  Serial.println(corps + 2);
  if (sdOk) {
    File f = SD.open("EVENTS.CSV", FILE_WRITE);
    if (f) {
      f.print(nomJournal);
      f.print(',');
      f.println(corps + 2);
      f.close();
    }
  }
#if TELEMETRIE
  char ligne[TAILLE_EVENEMENT];
  signer('#', corps, ligne, sizeof(ligne));
  memoriserEvenement(ligne);
#endif
}

// Ajoute la somme de contrôle : OU exclusif des caractères entre le premier caractère et '*'
void signer(char debut, const char* corps, char* sortie, size_t taille) {
  byte ck = 0;
  for (const char* c = corps; *c; c++) ck ^= *c;
  snprintf(sortie, taille, "%c%s*%02X\n", debut, corps, ck);
}

// Codes défaut, toutes les 5 s et dès qu'ils changent : #D,P0301,P0420*CK (la Nano ne les reçoit pas)
void envoyerCodes() {
  if (nbDefauts == INCONNU || (derniersCodes != 0 && millis() - derniersCodes < PERIODE_CODES)) return;
  derniersCodes = millis();
  char corps[8 + MAX_CODES * 6] = "D";
  for (byte i = 0; i < nbCodes; i++) {
    strcat(corps, ",");
    strcat(corps, codes[i]);
  }
  char ligne[sizeof(corps) + 8];
  signer('#', corps, ligne, sizeof(ligne));
#if TELEMETRIE
  memoriserTrame(ligne);
#endif
  Serial.print(ligne);
}

// Trame : $seq,t_ms,regime,temp,vitesse,charge,papillon,etat,voyant,defauts,tension*CK
// La Nano ne lit que les 8 premiers champs
void envoyerTrame() {
  if (millis() - derniereTrame < PERIODE_TRAME) return;
  derniereTrame = millis();

  int etat = calculerEtat();
  if (etat != dernierEtat) {
    noterEvenement(etat == ETAT_OK ? "ETAT_OK" : etat == ETAT_ERREUR_CAN ? "CAN_ERREUR" : "ECU_MUET", NOMS_ETATS[etat]);
    dernierEtat = etat;
  }
  char corps[80];
  snprintf(corps, sizeof(corps), "%lu,%lu,%d,%d,%d,%d,%d,%d,%d,%d,%d",
           sequence++, derniereTrame, regime, temp, vitesse, charge, papillon, etat, voyant, nbDefauts, tension);
  char trame[88];
  signer('$', corps, trame, sizeof(trame));

  // Vers la Nano (D1 / TX) et le serveur
  Serial1.print(trame);
#if TELEMETRIE
  memoriserTrame(trame);
#endif

  // Copie sur l'USB pour le debug
  Serial.print(trame);
  envoyerCodes();
}

// Régime : balaye 800 → 7000 → 800 tr/min en 10 s
// Température : monte de 20 à 125 °C en 60 s, puis recommence
void simulerDonnees() {
  unsigned long t = millis();

  unsigned long cycleRegime = t % 10000;
  bool monte = cycleRegime < 5000;
  if (monte) regime = map(cycleRegime, 0, 5000, 800, 7000);
  else       regime = map(cycleRegime, 5000, 10000, 7000, 800);

  temp = map(t % 60000, 0, 60000, 20, 125);
  vitesse = map(regime, 800, 7000, 0, 180);
  papillon = monte ? 100 : 0;
  charge = monte ? map(regime, 800, 7000, 40, 95) : 15;
  tension = 141;

  // voyant moteur allumé 15 s par minute, avec deux codes
  bool panne = t % 60000 >= 30000 && t % 60000 < 45000;
  voyant = panne;
  nbDefauts = panne ? 2 : 0;
  nbCodes = nbDefauts;
  if (panne && strcmp(codes[0], "P0301") != 0) {
    strcpy(codes[0], "P0301");
    strcpy(codes[1], "P0420");
    derniersCodes = 0;
  } else if (!panne && codes[0][0]) {
    codes[0][0] = '\0';
    derniersCodes = 0;
  }

  derniereReponse = t;
}

// ---------------------------------------------------

void setup() {
  Serial.begin(115200);    // USB (debug)
  Serial1.begin(19200);    // liaison vers la Nano
  pinMode(CAN_INT, INPUT);
  initialiserCan();
  ouvrirJournal();
  char detail[56];
  snprintf(detail, sizeof(detail), "simulation=%d can=%s sd=%s", SIMULATION, canOk ? "ok" : "erreur", nomJournal);
  noterEvenement("DEMARRAGE", detail);
}

void loop() {
#if SIMULATION
  canOk = true;
  simulerDonnees();
#else
  if (!canOk) {
    if (millis() - derniereInit >= PERIODE_REINIT) initialiserCan();
  } else {
    planifierRequetes();
    lireReponses();
  }
#endif
  enregistrer();
  envoyerTrame();
#if TELEMETRIE
  gererReseau();
#endif
}
