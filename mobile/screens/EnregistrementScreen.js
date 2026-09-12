/**
 * Écran 2 — Enregistrement d'un paiement de cotisation.
 * Sélection du membre (liste chargée depuis GET /api/stats), montant,
 * moyen de paiement, justificatif photo facultatif, puis envoi au backend.
 */
import React, { useCallback, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Image,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { Picker } from '@react-native-picker/picker';
import * as ImagePicker from 'expo-image-picker';
import { useFocusEffect } from '@react-navigation/native';
import Toast from 'react-native-toast-message';

import { recupererStats, enregistrerCotisation, messageErreur } from '../api/client';

const MOYENS = ['Mobile Money', 'Espèce'];

export default function EnregistrementScreen() {
  const [membres, setMembres] = useState([]);
  const [membreId, setMembreId] = useState(null);
  const [montant, setMontant] = useState('');
  const [moyen, setMoyen] = useState(MOYENS[0]);
  const [selectedImage, setSelectedImage] = useState(null);
  const [chargementMembres, setChargementMembres] = useState(true);
  const [envoiEnCours, setEnvoiEnCours] = useState(false);

  const estMonte = useRef(false);

  // La liste des membres alimente le sélecteur ; elle est relue à chaque affichage
  useFocusEffect(
    useCallback(() => {
      estMonte.current = true;
      setChargementMembres(true);

      recupererStats()
        .then((donnees) => {
          if (!estMonte.current) return;
          setMembres(donnees.members);
          // Présélection du premier membre pour éviter un envoi sans choix explicite
          setMembreId((precedent) => precedent ?? donnees.members[0]?.id ?? null);
          console.log(`[Enregistrement] ${donnees.members.length} membre(s) disponibles`);
        })
        .catch((exception) => {
          const message = messageErreur(exception);
          console.error(`[Enregistrement] liste des membres indisponible : ${message}`);
          Toast.show({ type: 'error', text1: 'Liste des membres indisponible', text2: message });
        })
        .finally(() => {
          if (estMonte.current) setChargementMembres(false);
        });

      return () => {
        estMonte.current = false;
      };
    }, [])
  );

  /**
   * Propose à l'utilisateur la caméra ou la galerie, puis récupère l'image choisie.
   */
  const selectionnerPhoto = () => {
    Alert.alert('Justificatif de paiement', 'Choisissez la source de la photo', [
      { text: 'Caméra', onPress: () => ouvrirSource('camera') },
      { text: 'Galerie', onPress: () => ouvrirSource('galerie') },
      { text: 'Annuler', style: 'cancel' },
    ]);
  };

  const ouvrirSource = async (source) => {
    try {
      const permission =
        source === 'camera'
          ? await ImagePicker.requestCameraPermissionsAsync()
          : await ImagePicker.requestMediaLibraryPermissionsAsync();

      if (!permission.granted) {
        console.warn(`[Enregistrement] permission refusée pour la source ${source}`);
        Toast.show({
          type: 'error',
          text1: 'Permission refusée',
          text2: "L'accès à la caméra ou aux photos est nécessaire",
        });
        return;
      }

      const options = { quality: 0.6, mediaTypes: ImagePicker.MediaTypeOptions.Images };
      const resultat =
        source === 'camera'
          ? await ImagePicker.launchCameraAsync(options)
          : await ImagePicker.launchImageLibraryAsync(options);

      if (resultat.canceled) {
        console.log('[Enregistrement] sélection de photo annulée');
        return;
      }

      const image = resultat.assets?.[0];
      if (!image?.uri) throw new Error('Image illisible');

      setSelectedImage(image);
      console.log(`[Enregistrement] justificatif sélectionné : ${image.fileName || image.uri}`);
    } catch (exception) {
      console.error(`[Enregistrement] échec de la sélection de photo : ${exception.message}`);
      Toast.show({ type: 'error', text1: 'Photo indisponible', text2: exception.message });
    }
  };

  const reinitialiserFormulaire = () => {
    setMontant('');
    setMoyen(MOYENS[0]);
    setSelectedImage(null);
  };

  /**
   * Valide la saisie puis envoie le paiement au backend.
   */
  const enregistrer = async () => {
    const montantNumerique = Number.parseFloat(String(montant).replace(',', '.'));
    const membre = membres.find((element) => element.id === membreId);

    if (!membre) {
      console.warn('[Enregistrement] refus : aucun membre sélectionné');
      Toast.show({ type: 'error', text1: 'Membre non sélectionné', text2: 'Choisissez un membre dans la liste' });
      return;
    }
    if (!Number.isFinite(montantNumerique) || montantNumerique <= 0) {
      console.warn(`[Enregistrement] refus : montant invalide « ${montant} »`);
      Toast.show({ type: 'error', text1: 'Montant invalide', text2: 'Saisissez un montant supérieur à zéro' });
      return;
    }

    setEnvoiEnCours(true);
    try {
      const cotisation = await enregistrerCotisation({
        memberId: membre.id,
        montant: montantNumerique,
        moyen,
        image: selectedImage,
      });

      console.log(`[Enregistrement] paiement envoyé : cotisation #${cotisation.id} pour ${membre.name}`);
      Toast.show({
        type: 'success',
        text1: 'Paiement enregistré',
        text2: `${membre.name} — ${montantNumerique} (${moyen})`,
      });
      reinitialiserFormulaire();
    } catch (exception) {
      const message = messageErreur(exception);
      console.error(`[Enregistrement] échec de l'envoi : ${message}`);
      Toast.show({ type: 'error', text1: 'Enregistrement impossible', text2: message });
    } finally {
      if (estMonte.current) setEnvoiEnCours(false);
    }
  };

  return (
    <ScrollView style={styles.conteneur} contentContainerStyle={styles.contenu} keyboardShouldPersistTaps="handled">
      <Text style={styles.etiquette}>Membre</Text>
      {chargementMembres ? (
        <View style={styles.cadreAttente}>
          <ActivityIndicator color="#0B6E4F" />
          <Text style={styles.texteAttente}>Chargement des membres…</Text>
        </View>
      ) : (
        <View style={styles.cadrePicker}>
          <Picker
            selectedValue={membreId}
            onValueChange={(valeur) => {
              setMembreId(valeur);
              console.log(`[Enregistrement] membre sélectionné : #${valeur}`);
            }}
            enabled={!envoiEnCours && membres.length > 0}
          >
            {membres.length === 0 ? (
              <Picker.Item label="Aucun membre disponible" value={null} />
            ) : (
              membres.map((membre) => (
                <Picker.Item
                  key={membre.id}
                  label={`${membre.name}${membre.paid ? ' (à jour)' : ''}`}
                  value={membre.id}
                />
              ))
            )}
          </Picker>
        </View>
      )}

      <Text style={styles.etiquette}>Montant</Text>
      <TextInput
        style={styles.champ}
        value={montant}
        onChangeText={setMontant}
        placeholder="5000"
        keyboardType="numeric"
        editable={!envoiEnCours}
      />

      <Text style={styles.etiquette}>Moyen de paiement</Text>
      <View style={styles.cadrePicker}>
        <Picker selectedValue={moyen} onValueChange={setMoyen} enabled={!envoiEnCours}>
          {MOYENS.map((option) => (
            <Picker.Item key={option} label={option} value={option} />
          ))}
        </Picker>
      </View>

      <Text style={styles.etiquette}>Justificatif (facultatif)</Text>
      <Pressable
        style={[styles.bouton, styles.boutonSecondaire, envoiEnCours && styles.boutonDesactive]}
        onPress={selectionnerPhoto}
        disabled={envoiEnCours}
      >
        <Text style={styles.texteBoutonSecondaire}>
          {selectedImage ? 'Changer la photo' : 'Sélectionner photo'}
        </Text>
      </Pressable>

      {selectedImage && <Image source={{ uri: selectedImage.uri }} style={styles.apercu} resizeMode="cover" />}

      <Pressable
        style={[styles.bouton, styles.boutonPrincipal, envoiEnCours && styles.boutonDesactive]}
        onPress={enregistrer}
        disabled={envoiEnCours}
      >
        {envoiEnCours ? (
          <ActivityIndicator color="#FFFFFF" />
        ) : (
          <Text style={styles.texteBoutonPrincipal}>Enregistrer paiement</Text>
        )}
      </Pressable>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  conteneur: { flex: 1, backgroundColor: '#F4F6F5' },
  contenu: { padding: 16, paddingBottom: 48 },
  etiquette: { fontSize: 14, fontWeight: '600', color: '#1C2B24', marginTop: 16, marginBottom: 6 },
  champ: {
    backgroundColor: '#FFFFFF',
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#D9E0DC',
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: 16,
    color: '#1C2B24',
  },
  cadrePicker: {
    backgroundColor: '#FFFFFF',
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#D9E0DC',
    overflow: 'hidden',
  },
  cadreAttente: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#FFFFFF',
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#D9E0DC',
    paddingVertical: 14,
    paddingHorizontal: 12,
  },
  texteAttente: { marginLeft: 10, color: '#5A6B63' },
  bouton: { borderRadius: 8, paddingVertical: 14, alignItems: 'center', justifyContent: 'center', marginTop: 12 },
  boutonPrincipal: { backgroundColor: '#0B6E4F', marginTop: 24 },
  boutonSecondaire: { backgroundColor: '#FFFFFF', borderWidth: 1, borderColor: '#0B6E4F' },
  boutonDesactive: { opacity: 0.6 },
  texteBoutonPrincipal: { color: '#FFFFFF', fontSize: 16, fontWeight: '700' },
  texteBoutonSecondaire: { color: '#0B6E4F', fontSize: 15, fontWeight: '600' },
  apercu: { width: '100%', height: 200, borderRadius: 8, marginTop: 12, backgroundColor: '#E4E9E6' },
});
