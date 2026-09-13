/// Service d'accès à l'API — Santé des extrêmes (LOT 2)
///
/// Cible désormais l'API déployée sur AWS :
///     https://sde-api.atlastech.cm/api
///
/// L'URL peut être surchargée sans recompiler le code source, au moment du
/// build :
///     flutter build apk --dart-define=API_BASE_URL=http://10.0.2.2:3000/api
///
/// Endpoints exposés par le backend Express :
///     GET    /api/health              sonde de santé
///     GET    /api/stats               tableau public des cotisations
///     POST   /api/cotisations         enregistrement d'un paiement (multipart)
///     POST   /api/admin/members       création d'un membre        (admin)
///     DELETE /api/admin/members/:id   suppression d'un membre     (admin)
///
/// Aucun secret n'est écrit en dur : le mot de passe administrateur est fourni
/// par l'utilisateur à l'exécution et transmis en en-tête Authorization.
///
/// Dépendance requise dans pubspec.yaml :
///     dependencies:
///       http: ^1.2.0
library;

import 'dart:convert';
import 'dart:io';

import 'package:http/http.dart' as http;

/// Erreur d'API porteuse d'un message affichable tel quel à l'utilisateur.
class ApiException implements Exception {
  ApiException(this.message, {this.statusCode});

  final String message;
  final int? statusCode;

  @override
  String toString() =>
      statusCode == null ? 'ApiException: $message' : 'ApiException($statusCode): $message';
}

/// Moyens de paiement acceptés par le backend (`normaliserMoyen`).
enum MoyenPaiement {
  mobileMoney('Mobile Money'),
  espece('Espèce');

  const MoyenPaiement(this.libelle);

  /// Valeur transmise au champ `moyen` de la requête.
  final String libelle;
}

/// Synthèse du tableau public.
class SyntheseCotisations {
  const SyntheseCotisations({
    required this.totalMembres,
    required this.aJour,
    required this.enRetard,
    required this.pourcentagePaye,
    this.moisCourant,
  });

  factory SyntheseCotisations.fromJson(Map<String, dynamic> json) {
    return SyntheseCotisations(
      totalMembres: _entier(json['total_members']),
      aJour: _entier(json['paid']),
      enRetard: _entier(json['unpaid']),
      pourcentagePaye: _decimal(json['percentage_paid']),
      moisCourant: json['current_month'] as String?,
    );
  }

  final int totalMembres;
  final int aJour;
  final int enRetard;
  final double pourcentagePaye;
  final String? moisCourant;
}

/// Ligne du tableau public : un membre et son état de paiement.
class MembreCotisation {
  const MembreCotisation({
    required this.id,
    required this.nom,
    required this.aJour,
    this.montant,
    this.moyen,
    this.dateEnregistrement,
    this.urlJustificatif,
  });

  factory MembreCotisation.fromJson(Map<String, dynamic> json) {
    return MembreCotisation(
      id: _entier(json['id']),
      nom: (json['name'] ?? '').toString(),
      aJour: json['paid'] == true || json['paid'] == 1,
      montant: json['montant'] == null ? null : _decimal(json['montant']),
      moyen: json['moyen'] as String?,
      dateEnregistrement: json['created_at'] as String?,
      // En production cette URL pointe sur la distribution CloudFront
      // (https://sde-cdn.atlastech.cm/...), pas directement sur le bucket S3.
      urlJustificatif: (json['image_url'] ?? json['justificatif_url']) as String?,
    );
  }

  final int id;
  final String nom;
  final bool aJour;
  final double? montant;
  final String? moyen;
  final String? dateEnregistrement;
  final String? urlJustificatif;
}

/// Résultat de `GET /api/stats`.
class TableauCotisations {
  const TableauCotisations({required this.synthese, required this.membres});

  final SyntheseCotisations synthese;
  final List<MembreCotisation> membres;
}

int _entier(Object? valeur) => switch (valeur) {
      final int v => v,
      final num v => v.round(),
      final String v => int.tryParse(v) ?? 0,
      _ => 0,
    };

double _decimal(Object? valeur) => switch (valeur) {
      final double v => v,
      final num v => v.toDouble(),
      final String v => double.tryParse(v) ?? 0,
      _ => 0,
    };

/// Client HTTP unique de l'application.
class ApiService {
  ApiService({String? baseUrl, http.Client? client, Duration? timeout})
      : baseUrl = _normaliser(baseUrl ?? defaultBaseUrl),
        _client = client ?? http.Client(),
        _timeout = timeout ?? const Duration(seconds: 20);

  /// API de production, déployée sur ECS Fargate derrière un ALB (eu-west-3).
  /// Surchargeable au build : --dart-define=API_BASE_URL=...
  static const String defaultBaseUrl = String.fromEnvironment(
    'API_BASE_URL',
    defaultValue: 'https://sde-api.atlastech.cm/api',
  );

  /// Diffusion des justificatifs (CloudFront).
  static const String mediaBaseUrl = String.fromEnvironment(
    'MEDIA_BASE_URL',
    defaultValue: 'https://sde-cdn.atlastech.cm',
  );

  final String baseUrl;
  final http.Client _client;
  final Duration _timeout;

  /// Retire la barre oblique finale ; conserve le suffixe `/api` attendu.
  static String _normaliser(String valeur) {
    final nettoyee = valeur.trim().replaceAll(RegExp(r'/+$'), '');
    return nettoyee.endsWith('/api') ? nettoyee : '$nettoyee/api';
  }

  Uri _uri(String chemin) => Uri.parse('$baseUrl$chemin');

  Map<String, String> _entetesAdmin(String motDePasseAdmin) => {
        // Le backend attend : Authorization: Bearer <ADMIN_PASSWORD>
        'Authorization': 'Bearer $motDePasseAdmin',
        'Content-Type': 'application/json; charset=utf-8',
        'Accept': 'application/json',
      };

  /// Décode une réponse JSON et convertit les erreurs backend en [ApiException].
  Map<String, dynamic> _decoder(http.Response reponse) {
    Map<String, dynamic> corps;
    try {
      corps = reponse.body.isEmpty
          ? <String, dynamic>{}
          : jsonDecode(reponse.body) as Map<String, dynamic>;
    } on FormatException {
      throw ApiException(
        'Réponse illisible du serveur (HTTP ${reponse.statusCode})',
        statusCode: reponse.statusCode,
      );
    }

    if (reponse.statusCode >= 200 && reponse.statusCode < 300) return corps;

    // Le backend renvoie systématiquement { "error": "..." } en cas d'échec.
    throw ApiException(
      (corps['error'] ?? _messageParDefaut(reponse.statusCode)).toString(),
      statusCode: reponse.statusCode,
    );
  }

  String _messageParDefaut(int code) => switch (code) {
        401 => 'Authentification requise',
        404 => 'Ressource introuvable',
        409 => 'Cet enregistrement existe déjà',
        413 => 'Fichier trop volumineux',
        >= 500 => 'Le serveur a rencontré une erreur, réessayez plus tard',
        _ => 'Requête refusée (HTTP $code)',
      };

  /// Traduit les pannes réseau en messages lisibles.
  Future<T> _executer<T>(Future<T> Function() action) async {
    try {
      return await action();
    } on SocketException {
      throw ApiException('Serveur injoignable, vérifiez votre connexion');
    } on HttpException {
      throw ApiException('Échange interrompu avec le serveur');
    } on HandshakeException {
      throw ApiException('Connexion sécurisée impossible (certificat HTTPS)');
    }
  }

  /// Sonde de santé : `GET /api/health`.
  Future<bool> verifierSante() async {
    return _executer(() async {
      final reponse = await _client.get(_uri('/health')).timeout(_timeout);
      return reponse.statusCode == 200;
    });
  }

  /// Tableau public : `GET /api/stats`.
  Future<TableauCotisations> recupererTableau() async {
    return _executer(() async {
      final reponse = await _client
          .get(_uri('/stats'), headers: {'Accept': 'application/json'})
          .timeout(_timeout);

      final corps = _decoder(reponse);
      final membres = (corps['members'] as List<dynamic>? ?? const [])
          .whereType<Map<String, dynamic>>()
          .map(MembreCotisation.fromJson)
          .toList(growable: false);

      final synthese = SyntheseCotisations.fromJson(
        corps['summary'] as Map<String, dynamic>? ??
            <String, dynamic>{
              'total_members': membres.length,
              'paid': 0,
              'unpaid': membres.length,
              'percentage_paid': 0,
            },
      );

      return TableauCotisations(synthese: synthese, membres: membres);
    });
  }

  /// Enregistre un paiement : `POST /api/cotisations` (multipart/form-data).
  ///
  /// [cheminJustificatif] est facultatif : une image (JPEG/PNG/WEBP/HEIC) de
  /// 5 Mo maximum, déposée sur S3 par le backend puis servie via CloudFront.
  Future<Map<String, dynamic>> enregistrerCotisation({
    required int membreId,
    required double montant,
    required MoyenPaiement moyen,
    String? cheminJustificatif,
  }) async {
    if (membreId <= 0) {
      throw ApiException('Identifiant de membre invalide');
    }
    if (montant <= 0) {
      throw ApiException('Le montant doit être strictement positif');
    }

    return _executer(() async {
      final requete = http.MultipartRequest('POST', _uri('/cotisations'))
        ..headers['Accept'] = 'application/json'
        ..fields['member_id'] = membreId.toString()
        ..fields['montant'] = montant.toString()
        ..fields['moyen'] = moyen.libelle;

      if (cheminJustificatif != null && cheminJustificatif.isNotEmpty) {
        final fichier = File(cheminJustificatif);
        if (!fichier.existsSync()) {
          throw ApiException('Justificatif introuvable : $cheminJustificatif');
        }
        // Le champ doit s'appeler « fichier » (multer .single('fichier')).
        requete.files.add(
          await http.MultipartFile.fromPath('fichier', cheminJustificatif),
        );
      }

      final flux = await _client.send(requete).timeout(_timeout);
      return _decoder(await http.Response.fromStream(flux));
    });
  }

  /// Création d'un membre : `POST /api/admin/members` (administration).
  Future<Map<String, dynamic>> creerMembre({
    required String nom,
    required String motDePasseAdmin,
  }) async {
    final nomNettoye = nom.trim();
    if (nomNettoye.isEmpty) {
      throw ApiException('Le nom du membre est obligatoire');
    }
    if (nomNettoye.length > 100) {
      throw ApiException('Le nom ne peut dépasser 100 caractères');
    }

    return _executer(() async {
      final reponse = await _client
          .post(
            _uri('/admin/members'),
            headers: _entetesAdmin(motDePasseAdmin),
            body: jsonEncode({'name': nomNettoye}),
          )
          .timeout(_timeout);

      return _decoder(reponse);
    });
  }

  /// Suppression d'un membre : `DELETE /api/admin/members/:id` (administration).
  ///
  /// Les cotisations associées sont supprimées en cascade côté base.
  Future<void> supprimerMembre({
    required int membreId,
    required String motDePasseAdmin,
  }) async {
    if (membreId <= 0) {
      throw ApiException('Identifiant de membre invalide');
    }

    await _executer(() async {
      final reponse = await _client
          .delete(
            _uri('/admin/members/$membreId'),
            headers: _entetesAdmin(motDePasseAdmin),
          )
          .timeout(_timeout);

      _decoder(reponse);
      return null;
    });
  }

  /// Libère le client HTTP sous-jacent.
  void dispose() => _client.close();
}
