/**
 * Point d'entrée de l'application mobile — Santé des extrêmes.
 * Deux onglets : le tableau public des cotisations et l'enregistrement d'un paiement.
 */
import React from 'react';
import { Text } from 'react-native';
import { NavigationContainer } from '@react-navigation/native';
import { createBottomTabNavigator } from '@react-navigation/bottom-tabs';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { StatusBar } from 'expo-status-bar';
import Toast from 'react-native-toast-message';

import TableauPublicScreen from './screens/TableauPublicScreen';
import EnregistrementScreen from './screens/EnregistrementScreen';

const Onglets = createBottomTabNavigator();

const COULEUR_PRINCIPALE = '#0B6E4F';

/**
 * Icône textuelle simple : évite une dépendance supplémentaire à une librairie d'icônes.
 */
function iconeOnglet(emoji) {
  return ({ size }) => <Text style={{ fontSize: size }}>{emoji}</Text>;
}

export default function App() {
  return (
    <SafeAreaProvider>
      <StatusBar style="light" />
      <NavigationContainer>
        <Onglets.Navigator
          initialRouteName="Tableau"
          screenOptions={{
            headerStyle: { backgroundColor: COULEUR_PRINCIPALE },
            headerTintColor: '#FFFFFF',
            headerTitleStyle: { fontWeight: 'bold' },
            tabBarActiveTintColor: COULEUR_PRINCIPALE,
            tabBarInactiveTintColor: '#8A8A8A',
          }}
        >
          <Onglets.Screen
            name="Tableau"
            component={TableauPublicScreen}
            options={{
              title: 'Tableau des cotisations',
              tabBarLabel: 'Tableau',
              tabBarIcon: iconeOnglet('📋'),
            }}
          />
          <Onglets.Screen
            name="Enregistrement"
            component={EnregistrementScreen}
            options={{
              title: 'Enregistrer un paiement',
              tabBarLabel: 'Paiement',
              tabBarIcon: iconeOnglet('💳'),
            }}
          />
        </Onglets.Navigator>
      </NavigationContainer>
      {/* Les notifications succès/erreur doivent rester au-dessus de la navigation */}
      <Toast />
    </SafeAreaProvider>
  );
}
