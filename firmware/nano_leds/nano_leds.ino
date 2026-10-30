// ===================================================
//  PitBox — Nano : affichage 5 LEDs
//  Titouan Beaurepaire
// ===================================================
#include <SoftwareSerial.h>

// --- Liaison avec la R4 ---
const int PIN_RX = 8;    // reçoit le TX (D1) de la R4
const int PIN_TX = 9;    // non utilisé
SoftwareSerial liaison(PIN_RX, PIN_TX);

// --- Pins LEDs ---
const int LED_BLANCHE = 3;   // fixe = attente de données, clignotante = liaison coupée (PWM)
const int LED_ROUGE   = 4;   // clignotante = mineur, fixe = majeur
const int LED_VERTE   = 5;   // passer la vitesse
const int LED_JAUNE   = 6;   // moteur froid
const int LED_BLEUE   = 7;   // rétrograder

const int LEDS[] = { LED_BLANCHE, LED_ROUGE, LED_VERTE, LED_JAUNE, LED_BLEUE };
const int NB_LEDS = 5;

const int LUMINOSITE_BLANCHE = 40;   // 0 à 255

// --- Seuils ---
const int REGIME_SHIFT   = 6000;  // tr/min
const int REGIME_RETRO   = 2000;  // tr/min
const int REGIME_RALENTI = 1100;  // tr/min
const int TEMP_FROID     = 70;    // °C
const int TEMP_MINEUR    = 105;   // °C
const int TEMP_MAJEUR    = 115;   // °C

// --- Timing ---
const unsigned long TIMEOUT_LIAISON     = 500;  // ms sans trame = liaison coupée
const unsigned long CLIGNOTEMENT_LENT   = 250;  // ms : problème mineur
const unsigned long CLIGNOTEMENT_RAPIDE = 100;  // ms : erreur shield CAN
const unsigned long CLIGNOTEMENT_LIAISON = 500; // ms : liaison avec la R4 coupée

// --- États reçus de la R4 ---
const int ETAT_PAS_DE_DONNEES = 0;
const int ETAT_OK             = 1;
const int ETAT_ERREUR_CAN     = 2;

const int INCONNU = -100;   // valeur jamais reçue par la R4

// --- Données reçues ---
int regime = 0;
int temp = 0;
int etat = ETAT_PAS_DE_DONNEES;
unsigned long derniereTrame = 0;

// --- Réception ---
char tampon[96];
byte position = 0;

// ---------------------------------------------------

// Trame (sans le '$') : seq,t_ms,regime,temp,vitesse,charge,papillon,etat[,voyant,defauts,tension]*CK
// Seuls les 8 premiers champs servent aux LEDs
// CK = OU exclusif des caractères avant '*', en hexadécimal
void traiterTrame(char* trame) {
  char* etoile = strchr(trame, '*');
  if (!etoile || !isxdigit(etoile[1]) || !isxdigit(etoile[2])) return;
  *etoile = '\0';
  byte ck = 0;
  for (char* c = trame; *c; c++) ck ^= *c;
  if (strtol(etoile + 1, nullptr, 16) != ck) return;   // trame abîmée

  unsigned long seq, instant;
  int r, t, vitesse, charge, papillon, e;
  if (sscanf(trame, "%lu,%lu,%d,%d,%d,%d,%d,%d", &seq, &instant, &r, &t, &vitesse, &charge, &papillon, &e) != 8) return;
  if (e < 0 || e > 2) return;
  if (r != INCONNU && (r < 0 || r > 12000)) return;
  if (t != INCONNU && (t < -40 || t > 215)) return;

  regime = r;
  temp = t;
  etat = e;
  derniereTrame = millis();
}

void lireLiaison() {
  while (liaison.available()) {
    char c = liaison.read();

    if (c == '$') {
      position = 0;
    } else if (c == '\n') {
      tampon[position] = '\0';
      traiterTrame(tampon);
      position = 0;
    } else if (position < sizeof(tampon) - 1) {
      tampon[position++] = c;
    } else {
      position = 0;   // trame trop longue : on la jette
    }
  }
}

void toutEteindre() {
  for (int i = 0; i < NB_LEDS; i++) digitalWrite(LEDS[i], LOW);
}

bool phase(unsigned long periode) {
  return (millis() / periode) % 2;
}

void mettreAJourLeds() {
  bool liaisonActive = derniereTrame != 0 && millis() - derniereTrame < TIMEOUT_LIAISON;

  if (!liaisonActive) {
    toutEteindre();
    analogWrite(LED_BLANCHE, phase(CLIGNOTEMENT_LIAISON) ? LUMINOSITE_BLANCHE : 0);
    return;
  }

  if (etat == ETAT_PAS_DE_DONNEES) {
    toutEteindre();
    analogWrite(LED_BLANCHE, LUMINOSITE_BLANCHE);
    return;
  }

  if (etat == ETAT_ERREUR_CAN) {
    toutEteindre();
    digitalWrite(LED_ROUGE, phase(CLIGNOTEMENT_RAPIDE));
    return;
  }

  // ETAT_OK
  digitalWrite(LED_BLANCHE, LOW);

  if (temp >= TEMP_MAJEUR)      digitalWrite(LED_ROUGE, HIGH);
  else if (temp >= TEMP_MINEUR) digitalWrite(LED_ROUGE, phase(CLIGNOTEMENT_LENT));
  else                          digitalWrite(LED_ROUGE, LOW);

  digitalWrite(LED_JAUNE, temp < TEMP_FROID);
  digitalWrite(LED_VERTE, regime >= REGIME_SHIFT);
  digitalWrite(LED_BLEUE, regime > REGIME_RALENTI && regime < REGIME_RETRO);
}

// ---------------------------------------------------

void setup() {
  for (int i = 0; i < NB_LEDS; i++) pinMode(LEDS[i], OUTPUT);
  liaison.begin(19200);
}

void loop() {
  lireLiaison();
  mettreAJourLeds();
}
