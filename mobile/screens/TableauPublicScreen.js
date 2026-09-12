/**
 * Écran 1 — Tableau public des cotisations.
 * Affichage seul (aucune authentification), rafraîchi automatiquement toutes les 30 s
 * et manuellement par tirer-pour-rafraîchir.
 */
import React, { useCallback, useRef, useState } from 'react';
import {
  ActivityIndicator,
  FlatList,
  RefreshControl,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { useFocusEffect } from '@react-navigation/native';

import { recupererStats, messageErreur } from '../api/client';

const INTERVALLE_RAFRAICHISSEMENT = 30000; // 30 secondes

/**
 * Met en forme une date ISO en date lisible en français.
 */
function formaterDate(dateIso) {
  if (!dateIso) return 'Aucun paiement enregistré';
  const date = new Date(String(dateIso).replace(' ', 'T'));
  if (Number.isNaN(date.getTime())) return 'Date inconnue';
  return `Dernier paiement : ${date.toLocaleDateString('fr-FR')}`;
}

export default function TableauPublicScreen() {
  const [membres, setMembres] = useState([]);
  const [synthese, setSynthese] = useState(null);
  const [chargement, setChargement] = useState(true);
  const [rafraichissement, setRafraichissement] = useState(false);
  const [erreur, setErreur] = useState(null);

  // Évite de mettre à jour l'état après le démontage de l'écran
  const estMonte = useRef(false);

  const charger = useCallback(async (silencieux = false) => {
    if (!silencieux) setChargement(true);
    try {
      const donnees = await recupererStats();
      if (!estMonte.current) return;
      setMembres(donnees.members);
      setSynthese(donnees.summary);
      setErreur(null);
      console.log(`[TableauPublic] données chargées : ${donnees.members.length} membre(s)`);
    } catch (exception) {
      if (!estMonte.current) return;
      const message = messageErreur(exception);
      console.error(`[TableauPublic] rafraîchissement impossible : ${message}`);
      setErreur(message);
    } finally {
      if (estMonte.current) {
        setChargement(false);
        setRafraichissement(false);
      }
    }
  }, []);

  // Polling actif uniquement lorsque l'onglet est affiché
  useFocusEffect(
    useCallback(() => {
      estMonte.current = true;
      charger(false);

      const minuteur = setInterval(() => {
        console.log('[TableauPublic] rafraîchissement automatique (30 s)');
        charger(true);
      }, INTERVALLE_RAFRAICHISSEMENT);

      return () => {
        estMonte.current = false;
        clearInterval(minuteur);
        console.log('[TableauPublic] écran quitté, polling arrêté');
      };
    }, [charger])
  );

  const surTirerPourRafraichir = useCallback(() => {
    console.log('[TableauPublic] rafraîchissement manuel demandé');
    setRafraichissement(true);
    charger(true);
  }, [charger]);

  const rendreMembre = ({ item }) => (
    <View style={styles.ligne}>
      <View style={styles.blocNom}>
        <Text style={styles.nom}>{item.name}</Text>
        <Text style={styles.sousTitre}>{formaterDate(item.last_paiement)}</Text>
      </View>
      <View style={styles.blocStatut}>
        <Text style={[styles.statut, item.paid ? styles.statutPaye : styles.statutImpaye]}>
          {item.paid ? '✓ Payé' : '✗ Impayé'}
        </Text>
        {item.montant_total > 0 && <Text style={styles.montant}>{item.montant_total}</Text>}
      </View>
    </View>
  );

  if (chargement && membres.length === 0) {
    return (
      <View style={styles.centre}>
        <ActivityIndicator size="large" color="#0B6E4F" />
        <Text style={styles.texteAttente}>Chargement du tableau…</Text>
      </View>
    );
  }

  return (
    <View style={styles.conteneur}>
      {erreur ? (
        <View style={styles.banniereErreur}>
          <Text style={styles.texteErreur}>{erreur}</Text>
        </View>
      ) : null}

      <FlatList
        data={membres}
        keyExtractor={(item) => String(item.id)}
        renderItem={rendreMembre}
        contentContainerStyle={membres.length === 0 ? styles.listeVide : styles.liste}
        refreshControl={
          <RefreshControl refreshing={rafraichissement} onRefresh={surTirerPourRafraichir} colors={['#0B6E4F']} />
        }
        ListHeaderComponent={
          synthese && synthese.total_members > 0 ? (
            <View style={styles.synthese}>
              <Text style={styles.titreSynthese}>Mois en cours : {synthese.current_month}</Text>
              <Text style={styles.detailSynthese}>
                {synthese.paid} à jour · {synthese.unpaid} en attente · {synthese.percentage_paid} % de{' '}
                {synthese.total_members} membres
              </Text>
            </View>
          ) : null
        }
        ListEmptyComponent={<Text style={styles.texteVide}>Aucun membre enregistré pour le moment.</Text>}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  conteneur: { flex: 1, backgroundColor: '#F4F6F5' },
  centre: { flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: '#F4F6F5' },
  texteAttente: { marginTop: 12, color: '#5A6B63' },
  liste: { padding: 12 },
  listeVide: { flexGrow: 1, alignItems: 'center', justifyContent: 'center', padding: 24 },
  texteVide: { color: '#5A6B63', textAlign: 'center' },
  synthese: {
    backgroundColor: '#E7F2ED',
    borderRadius: 10,
    paddingVertical: 12,
    paddingHorizontal: 16,
    marginBottom: 12,
  },
  titreSynthese: { fontSize: 14, fontWeight: '700', color: '#0B6E4F' },
  detailSynthese: { fontSize: 13, color: '#3E5A4F', marginTop: 4 },
  ligne: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    backgroundColor: '#FFFFFF',
    borderRadius: 10,
    paddingVertical: 14,
    paddingHorizontal: 16,
    marginBottom: 8,
    elevation: 1,
  },
  blocNom: { flex: 1, paddingRight: 12 },
  blocStatut: { alignItems: 'flex-end' },
  nom: { fontSize: 16, fontWeight: '600', color: '#1C2B24' },
  sousTitre: { fontSize: 12, color: '#7A8A82', marginTop: 2 },
  statut: { fontSize: 14, fontWeight: '700' },
  statutPaye: { color: '#0B6E4F' },
  statutImpaye: { color: '#B3261E' },
  montant: { fontSize: 12, color: '#7A8A82', marginTop: 2 },
  banniereErreur: { backgroundColor: '#FDECEA', paddingVertical: 8, paddingHorizontal: 16 },
  texteErreur: { color: '#B3261E', fontSize: 13, textAlign: 'center' },
});
