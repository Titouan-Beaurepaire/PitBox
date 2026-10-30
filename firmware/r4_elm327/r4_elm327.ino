// ===================================================
//  PitBox — R4 WiFi : acquisition OBD-II par un boîtier ELM327 WiFi
//  et envoi à la Nano
//  Titouan Beaurepaire
// ===================================================
#include <WiFiS3.h>

#define SIMULATION 0   // 1 = données simulées, 0 = vraie voiture

// --- Boîtier ELM327 WiFi ---
const char* ELM_SSID = "WiFi_OBDII";       // nom du réseau créé par le boîtier
const IPAddress ELM_IP(192, 168, 0, 10);   // adresse habituelle des ELM327 WiFi
const uint16_t ELM_PORT = 35000;
WiFiClient elm;

// Configuration du boîtier, une commande à la fois
const char* CONFIG[] = {
  "ATZ",     // redémarrage
  "ATE0",    // pas d'écho des commandes
  "ATL0",    // pas de saut de ligne
  "ATS0",    // pas d'espaces : "410C1AF8"
  "ATH0",    // pas d'en-têtes CAN
  "ATSP6",   // CAN 11 bits à 500 kbit/s, celui de la 208 (ATSP0 = recherche auto)
};
const byte NB_CONFIG = sizeof(CONFIG) / sizeof(CONFIG[0]);

// --- OBD-II (mode 01 + PID, en texte) ---
const char* REQUETE_REGIME = "010C";
const char* REQUETE_TEMP   = "0105";

// --- Timing ---
const unsigned long PERIODE_TRAME       = 100;   // ms : envoi vers la Nano
const unsigned long TIMEOUT_ECU         = 2000;  // ms sans réponse = pas de données
const unsigned long TIMEOUT_CONFIG      = 3000;  // ms : ATZ peut être long
const unsigned long TIMEOUT_MESURE      = 1500;  // ms
const unsigned long PERIODE_RECONNEXION = 3000;  // ms entre deux tentatives
const byte MAX_ECHECS = 3;                       // délais dépassés d'affilée avant de se reconnecter

// --- États envoyés à la Nano ---
const int ETAT_PAS_DE_DONNEES  = 0;
const int ETAT_OK              = 1;
const int ETAT_ERREUR_BOITIER  = 2;   // même code que l'erreur CAN : rouge rapide sur la Nano

// --- Connexion au boîtier ---
enum Etape { WIFI, TCP, CONFIGURATION, MESURES };
const char* NOMS_ETAPES[] = { "WIFI", "TCP", "CONFIG", "MESURES" };
Etape etape = WIFI;
byte etapeConfig = 0;
byte echecs = 0;
bool attenteReponse = false;
bool demandeTemp = false;
unsigned long debutCommande = 0;
unsigned long derniereTentative = 0;

// --- Réponse du boîtier ---
char reponse[64];
byte longueur = 0;

// --- Données ---
int regime = 0;
int temp = 0;
bool regimeRecu = false;
bool tempRecue = false;
unsigned long derniereReponse = 0;
unsigned long derniereTrame = 0;
byte compteurRequetes = 0;
unsigned long sequence = 0;
const int INCONNU = -100;   // valeur jamais reçue

// ---------------------------------------------------

bool peutRetenter() {
  return derniereTentative == 0 || millis() - derniereTentative >= PERIODE_RECONNEXION;
}

void deconnecter() {
  elm.stop();
  attenteReponse = false;
  etape = WiFi.status() == WL_CONNECTED ? TCP : WIFI;
  derniereTentative = millis();
}

// Sécurité : la R4 ne fait que LIRE la voiture. Seules passent la configuration du boîtier
// (liste CONFIG ci-dessus) et les demandes de mesures en mode 01 ("01" + PID).
// Effacer les codes (04), écrire ou piloter un calculateur est refusé.
bool commandeAutorisee(const char* commande) {
  for (byte i = 0; i < NB_CONFIG; i++) {
    if (strcmp(commande, CONFIG[i]) == 0) return true;
  }
  return strlen(commande) == 4 && strncmp(commande, "01", 2) == 0 &&
         isxdigit(commande[2]) && isxdigit(commande[3]);
}

void envoyerCommande(const char* commande) {
  if (!commandeAutorisee(commande)) {
    Serial.print("Commande bloquee : ");
    Serial.println(commande);
    return;
  }
  while (elm.available()) elm.read();   // on jette les restes d'une réponse précédente
  elm.print(commande);
  elm.print('\r');
  longueur = 0;
  attenteReponse = true;
  debutCommande = millis();
}

// Renvoie true quand le boîtier a fini de répondre (invite '>')
bool lireReponse() {
  while (elm.available()) {
    char c = elm.read();
    if (c == '>') {
      reponse[longueur] = '\0';
      attenteReponse = false;
      return true;
    }
    if (longueur < sizeof(reponse) - 1) reponse[longueur++] = c;
  }
  return false;
}

// Cherche la réponse au PID (ex. "410C") et lit les octets qui la suivent
bool extraire(const char* entete, byte* octets, byte nb) {
  char* p = strstr(reponse, entete);
  if (!p) return false;
  p += strlen(entete);
  for (byte i = 0; i < nb; i++, p += 2) {
    if (!isxdigit(p[0]) || !isxdigit(p[1])) return false;
    char hex[3] = { p[0], p[1], '\0' };
    octets[i] = strtol(hex, nullptr, 16);
  }
  return true;
}

// "NO DATA", "SEARCHING..." ou "CAN ERROR" ne correspondent à aucun PID : ignorés
void traiterMesure() {
  byte o[2];
  if (!demandeTemp && extraire("410C", o, 2)) {
    regime = ((uint16_t)o[0] << 8 | o[1]) / 4;
    regimeRecu = true;
    derniereReponse = millis();
  } else if (demandeTemp && extraire("4105", o, 1)) {
    temp = o[0] - 40;
    tempRecue = true;
    derniereReponse = millis();
  }
}

// Régime 4 fois sur 5, température 1 fois sur 5
void envoyerRequete() {
  demandeTemp = compteurRequetes == 4;
  envoyerCommande(demandeTemp ? REQUETE_TEMP : REQUETE_REGIME);
  compteurRequetes = (compteurRequetes + 1) % 5;
}

void gererBoitier() {
  switch (etape) {
    case WIFI:
      if (!peutRetenter()) return;
      derniereTentative = millis();
      if (WiFi.begin(ELM_SSID) == WL_CONNECTED) etape = TCP;   // bloque quelques secondes
      return;

    case TCP:
      if (WiFi.status() != WL_CONNECTED) { etape = WIFI; return; }
      if (!peutRetenter()) return;
      derniereTentative = millis();
      if (elm.connect(ELM_IP, ELM_PORT)) {
        etape = CONFIGURATION;
        etapeConfig = 0;
        echecs = 0;
      }
      return;

    case CONFIGURATION:
    case MESURES:
      if (WiFi.status() != WL_CONNECTED || !elm.connected()) { deconnecter(); return; }

      if (attenteReponse) {
        if (lireReponse()) {
          echecs = 0;
          if (etape == MESURES) traiterMesure();
          else if (++etapeConfig == NB_CONFIG) etape = MESURES;
        } else if (millis() - debutCommande > (etape == CONFIGURATION ? TIMEOUT_CONFIG : TIMEOUT_MESURE)) {
          attenteReponse = false;   // on renverra la même commande
          if (++echecs >= MAX_ECHECS) deconnecter();
        }
        return;
      }

      if (etape == CONFIGURATION) envoyerCommande(CONFIG[etapeConfig]);
      else                        envoyerRequete();
      return;
  }
}

int calculerEtat() {
  if (etape != MESURES) return ETAT_ERREUR_BOITIER;
  bool ecuActif = derniereReponse != 0 && millis() - derniereReponse < TIMEOUT_ECU;
  if (ecuActif && regimeRecu && tempRecue) return ETAT_OK;
  return ETAT_PAS_DE_DONNEES;
}

// Trame : $seq,t_ms,regime,temp,vitesse,charge,papillon,etat*CK
// CK = OU exclusif des caractères entre '$' et '*', en hexadécimal
// Vitesse, charge et papillon ne sont pas encore demandés au boîtier : INCONNU
void envoyerTrame() {
  if (millis() - derniereTrame < PERIODE_TRAME) return;
  derniereTrame = millis();

  int etat = calculerEtat();
  char corps[64];
  snprintf(corps, sizeof(corps), "%lu,%lu,%d,%d,%d,%d,%d,%d",
           sequence++, derniereTrame, regime, temp, INCONNU, INCONNU, INCONNU, etat);
  byte ck = 0;
  for (char* c = corps; *c; c++) ck ^= *c;
  char trame[72];
  snprintf(trame, sizeof(trame), "$%s*%02X\n", corps, ck);

  // Vers la Nano (D1 / TX)
  Serial1.print(trame);

  // Copie sur l'USB pour le debug
  Serial.print("Boitier: ");
  Serial.print(NOMS_ETAPES[etape]);
  Serial.print(" | ");
  Serial.print(trame);
}

// Régime : balaye 800 → 7000 → 800 tr/min en 10 s
// Température : monte de 20 à 125 °C en 60 s, puis recommence
void simulerDonnees() {
  unsigned long t = millis();

  unsigned long cycleRegime = t % 10000;
  if (cycleRegime < 5000) regime = map(cycleRegime, 0, 5000, 800, 7000);
  else                    regime = map(cycleRegime, 5000, 10000, 7000, 800);

  temp = map(t % 60000, 0, 60000, 20, 125);

  regimeRecu = true;
  tempRecue = true;
  derniereReponse = t;
}

// ---------------------------------------------------

void setup() {
  Serial.begin(115200);    // USB (debug)
  Serial1.begin(19200);    // liaison vers la Nano
  if (WiFi.status() == WL_NO_MODULE) Serial.println("Module WiFi introuvable");
}

void loop() {
#if SIMULATION
  etape = MESURES;
  simulerDonnees();
#else
  gererBoitier();
#endif
  envoyerTrame();
}
