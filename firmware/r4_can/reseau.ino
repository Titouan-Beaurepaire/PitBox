// ===================================================
//  PitBox — R4 : envoi des trames au serveur PitLabs (WiFi + WebSocket)
// ===================================================
#include <WiFiS3.h>
#include "arduino_secrets.h"

// --- Serveur PitLabs ---
const char* SERVEUR_HOTE = SECRET_HOTE;                 // le VPS OVH (ou l'IP de ton PC pour les tests)
const uint16_t SERVEUR_PORT = 443;                      // 443 en TLS ; 8000 sur le PC
#define SERVEUR_TLS 1                                   // 1 = wss:// (certificat Let's Encrypt du VPS)

#if SERVEUR_TLS
WiFiSSLClient serveur;
#else
WiFiClient serveur;
#endif

// --- Timing ---
const unsigned long PERIODE_ENVOI     = 250;    // ms : les trames partent par paquets
const unsigned long PERIODE_WIFI      = 15000;  // ms entre deux recherches du WiFi (bloquantes)
const unsigned long PERIODE_CONNEXION = 3000;   // ms entre deux connexions au serveur
const unsigned long TIMEOUT_SERVEUR   = 3000;   // ms pour la poignée de main WebSocket

// --- Tampon : les trames attendent ici pendant les coupures réseau ---
const int TAMPON_TRAMES = 125;   // 12 s à 10 trames/s ; au-delà, la carte SD a tout
const int TAILLE_TRAME  = 72;
const int LOT_MAX       = 25;    // trames par message WebSocket
char trames[TAMPON_TRAMES][TAILLE_TRAME];
int premiereTrame = 0;
int nbTrames = 0;
unsigned long tramesEcrasees = 0;   // perdues pendant une coupure trop longue (la SD les a)

// --- Événements : file à part, pour qu'une longue coupure ne les noie pas sous les trames ---
const int TAMPON_EVENEMENTS = 12;
char evenements[TAMPON_EVENEMENTS][TAILLE_EVENEMENT];
int premierEvenement = 0;
int nbEvenements = 0;

bool webSocketOuvert = false;
bool wifiConnecte = false;
unsigned long echecsServeur = 0;
unsigned long debutCoupure = 0;
unsigned long derniereRechercheWifi = 0;
unsigned long derniereConnexion = 0;
unsigned long dernierEnvoi = 0;

// ---------------------------------------------------

void memoriserTrame(const char* trame) {
  int i = (premiereTrame + nbTrames) % TAMPON_TRAMES;
  if (nbTrames == TAMPON_TRAMES) {   // plein : on perd la plus ancienne
    premiereTrame = (premiereTrame + 1) % TAMPON_TRAMES;
    tramesEcrasees++;
  } else {
    nbTrames++;
  }
  strncpy(trames[i], trame, TAILLE_TRAME - 1);
  trames[i][TAILLE_TRAME - 1] = '\0';
}

void memoriserEvenement(const char* ligne) {
  int i = (premierEvenement + nbEvenements) % TAMPON_EVENEMENTS;
  if (nbEvenements == TAMPON_EVENEMENTS) premierEvenement = (premierEvenement + 1) % TAMPON_EVENEMENTS;
  else nbEvenements++;
  strncpy(evenements[i], ligne, TAILLE_EVENEMENT - 1);
  evenements[i][TAILLE_EVENEMENT - 1] = '\0';
}

// Attend un octet du serveur (les trames du serveur arrivent parfois en plusieurs morceaux)
int lireOctet() {
  unsigned long debut = millis();
  while (!serveur.available()) {
    if (millis() - debut > 100) return -1;
  }
  return serveur.read();
}

// Un message WebSocket envoyé par un client est toujours masqué (RFC 6455)
bool envoyerMessage(uint8_t type, uint8_t* donnees, size_t taille) {
  uint8_t entete[8];
  size_t n = 0;
  entete[n++] = 0x80 | type;   // FIN + type
  if (taille < 126) {
    entete[n++] = 0x80 | taille;
  } else {
    entete[n++] = 0x80 | 126;
    entete[n++] = taille >> 8;
    entete[n++] = taille & 0xff;
  }
  uint8_t* masque = entete + n;
  for (int i = 0; i < 4; i++) masque[i] = random(256);
  n += 4;
  for (size_t i = 0; i < taille; i++) donnees[i] ^= masque[i % 4];
  // deux écritures seulement : chacune passe par la puce WiFi et prend quelques ms
  return serveur.write(entete, n) == n && serveur.write(donnees, taille) == taille;
}

bool ouvrirWebSocket() {
  if (!serveur.connect(SERVEUR_HOTE, SERVEUR_PORT)) return false;

  char requete[320];
  int n = snprintf(requete, sizeof(requete),
                   "GET /ws/ingest?token=%s HTTP/1.1\r\n"
                   "Host: %s\r\n"
                   "Upgrade: websocket\r\n"
                   "Connection: Upgrade\r\n"
                   "Sec-WebSocket-Key: UGl0Qm94UjRUZWxlbWV0cg==\r\n"
                   "Sec-WebSocket-Version: 13\r\n\r\n",
                   SECRET_JETON, SERVEUR_HOTE);
  serveur.write((uint8_t*)requete, n);

  // La réponse doit commencer par "HTTP/1.1 101" ; on lit jusqu'à la ligne vide qui finit les en-têtes
  char statut[13] = { 0 };
  byte lus = 0;
  uint32_t fin = 0;
  unsigned long debut = millis();
  while (fin != 0x0D0A0D0A) {
    if (millis() - debut > TIMEOUT_SERVEUR) return false;
    if (!serveur.available()) continue;
    char c = serveur.read();
    if (lus < sizeof(statut) - 1) statut[lus++] = c;
    fin = (fin << 8) | (uint8_t)c;
  }
  return strncmp(statut + 9, "101", 3) == 0;
}

// Le serveur envoie des pings pour vérifier que la R4 est toujours là : il faut répondre
void lireServeur() {
  while (serveur.available() >= 2) {
    uint8_t type = serveur.read() & 0x0f;
    size_t taille = serveur.read() & 0x7f;
    if (taille == 126) {
      int fort = lireOctet();   // deux lectures séparées : l'ordre d'évaluation de a | b n'est pas garanti
      taille = (fort << 8) | lireOctet();
    }

    uint8_t contenu[125];
    for (size_t i = 0; i < taille; i++) {
      int c = lireOctet();
      if (c < 0) return;
      if (i < sizeof(contenu)) contenu[i] = c;
    }
    if (type == 0x9) envoyerMessage(0xA, contenu, min(taille, sizeof(contenu)));   // ping → pong
    if (type == 0x8) serveur.stop();                                                 // fermeture
  }
}

bool envoyerLot() {
  static uint8_t donnees[TAMPON_EVENEMENTS * TAILLE_EVENEMENT + LOT_MAX * TAILLE_TRAME];
  size_t taille = 0;
  int ev = 0;
  for (; ev < nbEvenements; ev++) {   // les événements d'abord
    const char* e = evenements[(premierEvenement + ev) % TAMPON_EVENEMENTS];
    size_t l = strlen(e);
    memcpy(donnees + taille, e, l);
    taille += l;
  }
  int nb = 0;
  for (; nb < nbTrames && nb < LOT_MAX; nb++) {
    const char* t = trames[(premiereTrame + nb) % TAMPON_TRAMES];   // chaque trame finit par '\n'
    size_t l = strlen(t);
    memcpy(donnees + taille, t, l);
    taille += l;
  }
  if (!envoyerMessage(0x1, donnees, taille)) return false;
  premierEvenement = (premierEvenement + ev) % TAMPON_EVENEMENTS;
  nbEvenements -= ev;
  premiereTrame = (premiereTrame + nb) % TAMPON_TRAMES;
  nbTrames -= nb;
  return true;
}

void gererReseau() {
  if (WiFi.status() != WL_CONNECTED) {
    if (wifiConnecte) {
      wifiConnecte = false;
      noterEvenement("WIFI_PERDU", SECRET_SSID);
    }
    if (webSocketOuvert && debutCoupure == 0) debutCoupure = millis();
    webSocketOuvert = false;
    if (derniereRechercheWifi != 0 && millis() - derniereRechercheWifi < PERIODE_WIFI) return;
    derniereRechercheWifi = millis();
    Serial.println("WiFi : recherche...");
    if (WiFi.begin(SECRET_SSID, SECRET_PASS) == WL_CONNECTED) {   // bloque quelques secondes
      wifiConnecte = true;
      char detail[48];
      snprintf(detail, sizeof(detail), "%s, signal %ld dBm", SECRET_SSID, WiFi.RSSI());
      noterEvenement("WIFI_OK", detail);
    }
    return;
  }

  if (!webSocketOuvert || !serveur.connected()) {
    if (webSocketOuvert) {
      noterEvenement("SERVEUR_PERDU", "connexion WebSocket coupee");
      debutCoupure = millis();
    }
    webSocketOuvert = false;
    serveur.stop();
    if (millis() - derniereConnexion < PERIODE_CONNEXION) return;
    derniereConnexion = millis();
    webSocketOuvert = ouvrirWebSocket();
    if (!webSocketOuvert) {
      serveur.stop();
      if (++echecsServeur % 10 == 1) Serial.println("Serveur : injoignable");
      return;
    }
    char detail[64];
    snprintf(detail, sizeof(detail), "apres %lu essai(s), coupure %lu s, %lu trames ecrasees",
             echecsServeur + 1, debutCoupure ? (millis() - debutCoupure) / 1000 : 0, tramesEcrasees);
    noterEvenement("SERVEUR_OK", detail);
    echecsServeur = 0;
    debutCoupure = 0;
    tramesEcrasees = 0;
    return;
  }

  lireServeur();
  if (nbTrames > 0 && millis() - dernierEnvoi >= PERIODE_ENVOI) {
    dernierEnvoi = millis();
    if (!envoyerLot()) serveur.stop();   // la connexion sera rouverte au prochain tour
  }
}
