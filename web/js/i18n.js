// ============================================
// Scratchy — i18n Translation System
// ============================================
// Supports: en, fr, ar, it
// Usage: window.applyI18n(lang) — applies translations to all [data-i18n] elements
//        window.t(key) — returns translated string for current language
// ============================================

(function () {
  'use strict';

  var currentLang = 'en';

  var translations = {
    // ═══════════════════════════════════════
    // ENGLISH
    // ═══════════════════════════════════════
    en: {
      // Subtitles
      'sub.language': 'Choose your language',
      'sub.loading': 'Checking session\u2026',
      'sub.login': 'Sign in to continue',
      'sub.bootstrap': 'Create your admin account',
      'sub.plan': 'How do you want to use AI?',
      'sub.provider': 'Connect your AI provider',
      'sub.passkey': 'Welcome back!',

      // Login form
      'login.email': 'Email',
      'login.email.ph': 'you@example.com',
      'login.password': 'Password',
      'login.password.ph': 'Enter password',
      'login.submit': 'Sign In',
      'login.passkey': 'Sign in with Passkey',
      'login.or': 'or',

      // Registration form
      'reg.name': 'Display Name',
      'reg.name.ph': 'Your name',
      'reg.email': 'Email',
      'reg.email.ph': 'you@example.com',
      'reg.password': 'Password',
      'reg.password.ph': 'Choose a strong password',
      'reg.confirm': 'Confirm Password',
      'reg.confirm.ph': 'Confirm password',
      'reg.submit': 'Create Admin Account',

      // Plan choice
      'plan.own.title': '\ud83d\udd11 Bring Your Own Key',
      'plan.own.desc': 'Use your OpenAI, Google Gemini, or Anthropic Claude subscription. You pay for your usage directly.',
      'plan.own.tag': 'No quotas',
      'plan.hosted.title': '\ud83c\udf9f\ufe0f Use Hosted AI',
      'plan.hosted.desc': 'Use this instance\u2019s shared tokens. Quick start \u2014 no API key needed. Usage quotas apply.',
      'plan.hosted.tag': 'Ready to go',
      'plan.hint': 'You can change this later in Settings.',

      // Provider key
      'prov.openai': 'OpenAI',
      'prov.openai.desc': 'GPT-4o, o1, Codex',
      'prov.anthropic': 'Anthropic',
      'prov.anthropic.desc': 'Claude Opus, Sonnet, Haiku',
      'prov.google': 'Google',
      'prov.google.desc': 'Gemini Pro, Gemini Flash',
      'prov.key.label': 'API Key',
      'prov.validate': 'Validate & Save',
      'prov.back': '\u2190 Change provider',
      'prov.skip': 'I\u2019ll add it later in Settings',

      // Provider hints
      'prov.hint.openai': 'Starts with sk-\u2026 \u2014 get yours at platform.openai.com/api-keys',
      'prov.hint.anthropic': 'Starts with sk-ant-\u2026 \u2014 get yours at console.anthropic.com/settings/keys',
      'prov.hint.google': 'Get yours at aistudio.google.com/apikey',

      // Passkey setup
      'pk.title': '\ud83d\udd10 Add a Passkey?',
      'pk.desc': 'Sign in faster next time with Face ID, Touch ID, or your security key.',
      'pk.setup': 'Set Up',
      'pk.skip': 'Not Now',

      // Loading
      'loading.text': 'Connecting\u2026',

      // Footer
      'footer.text': 'Secured by',
      'footer.fork': 'forked from',

      // Errors
      'err.email': 'Please enter your email.',
      'err.password': 'Please enter your password.',
      'err.name': 'Please enter a display name.',
      'err.email.reg': 'Please enter an email address.',
      'err.password.choose': 'Please choose a password.',
      'err.password.short': 'Password must be at least 8 characters.',
      'err.password.match': 'Passwords do not match.',
      'err.connection': 'Could not reach server. Check your connection.',
      'err.login.fail': 'Invalid email or password.',
      'err.retry': 'Connection failed. Please try again.',
      'err.key.empty': 'Please enter your API key.',
      'err.key.short': 'That key looks too short. Please check and try again.',
      'err.key.fail': 'Key validation failed. Please check and try again.',
      'err.passkey.fail': 'Passkey authentication failed. Try password login.',
      'err.passkey.https': 'Passkeys require a secure context (HTTPS).',
      'err.passkey.setup': 'Could not set up passkey. You can add one later in Settings.',
      'err.lockout': 'Too many attempts. Try again in',

      // Success
      'ok.created': 'Account created!',
      'ok.key': 'Key validated! Connecting\u2026',
      'ok.passkey': 'Passkey added! Redirecting\u2026',
      'ok.passkey.exists': 'Passkey already registered! Redirecting\u2026',
      'ok.redirect': 'Redirecting\u2026',
    },

    // ═══════════════════════════════════════
    // FRENCH
    // ═══════════════════════════════════════
    fr: {
      'sub.language': 'Choisissez votre langue',
      'sub.loading': 'V\u00e9rification\u2026',
      'sub.login': 'Connectez-vous pour continuer',
      'sub.bootstrap': 'Cr\u00e9ez votre compte administrateur',
      'sub.plan': 'Comment voulez-vous utiliser l\u2019IA\u00a0?',
      'sub.provider': 'Connectez votre fournisseur IA',
      'sub.passkey': 'Bon retour\u00a0!',

      'login.email': 'E-mail',
      'login.email.ph': 'vous@exemple.com',
      'login.password': 'Mot de passe',
      'login.password.ph': 'Entrez votre mot de passe',
      'login.submit': 'Se connecter',
      'login.passkey': 'Se connecter avec Passkey',
      'login.or': 'ou',

      'reg.name': 'Nom d\u2019affichage',
      'reg.name.ph': 'Votre nom',
      'reg.email': 'E-mail',
      'reg.email.ph': 'vous@exemple.com',
      'reg.password': 'Mot de passe',
      'reg.password.ph': 'Choisissez un mot de passe fort',
      'reg.confirm': 'Confirmer le mot de passe',
      'reg.confirm.ph': 'Confirmez le mot de passe',
      'reg.submit': 'Cr\u00e9er le compte admin',

      'plan.own.title': '\ud83d\udd11 Utilisez votre propre cl\u00e9',
      'plan.own.desc': 'Utilisez votre abonnement OpenAI, Google Gemini ou Anthropic Claude. Vous payez votre consommation directement.',
      'plan.own.tag': 'Sans quota',
      'plan.hosted.title': '\ud83c\udf9f\ufe0f Utiliser l\u2019IA h\u00e9berg\u00e9e',
      'plan.hosted.desc': 'Utilisez les jetons partag\u00e9s de cette instance. D\u00e9marrage rapide \u2014 pas de cl\u00e9 API n\u00e9cessaire. Des quotas s\u2019appliquent.',
      'plan.hosted.tag': 'Pr\u00eat \u00e0 l\u2019emploi',
      'plan.hint': 'Vous pouvez modifier ce choix plus tard dans les Param\u00e8tres.',

      'prov.openai': 'OpenAI',
      'prov.openai.desc': 'GPT-4o, o1, Codex',
      'prov.anthropic': 'Anthropic',
      'prov.anthropic.desc': 'Claude Opus, Sonnet, Haiku',
      'prov.google': 'Google',
      'prov.google.desc': 'Gemini Pro, Gemini Flash',
      'prov.key.label': 'Cl\u00e9 API',
      'prov.validate': 'Valider et enregistrer',
      'prov.back': '\u2190 Changer de fournisseur',
      'prov.skip': 'Je l\u2019ajouterai plus tard dans les Param\u00e8tres',

      'prov.hint.openai': 'Commence par sk-\u2026 \u2014 obtenez-la sur platform.openai.com/api-keys',
      'prov.hint.anthropic': 'Commence par sk-ant-\u2026 \u2014 obtenez-la sur console.anthropic.com/settings/keys',
      'prov.hint.google': 'Obtenez-la sur aistudio.google.com/apikey',

      'pk.title': '\ud83d\udd10 Ajouter une Passkey\u00a0?',
      'pk.desc': 'Connectez-vous plus vite la prochaine fois avec Face ID, Touch ID ou votre cl\u00e9 de s\u00e9curit\u00e9.',
      'pk.setup': 'Configurer',
      'pk.skip': 'Plus tard',

      'loading.text': 'Connexion\u2026',

      'footer.text': 'Sécurisé par',
      'footer.fork': 'fork de',

      'err.email': 'Veuillez entrer votre e-mail.',
      'err.password': 'Veuillez entrer votre mot de passe.',
      'err.name': 'Veuillez entrer un nom d\u2019affichage.',
      'err.email.reg': 'Veuillez entrer une adresse e-mail.',
      'err.password.choose': 'Veuillez choisir un mot de passe.',
      'err.password.short': 'Le mot de passe doit contenir au moins 8 caract\u00e8res.',
      'err.password.match': 'Les mots de passe ne correspondent pas.',
      'err.connection': 'Impossible de joindre le serveur. V\u00e9rifiez votre connexion.',
      'err.login.fail': 'E-mail ou mot de passe incorrect.',
      'err.retry': 'Connexion \u00e9chou\u00e9e. Veuillez r\u00e9essayer.',
      'err.key.empty': 'Veuillez entrer votre cl\u00e9 API.',
      'err.key.short': 'Cette cl\u00e9 semble trop courte. V\u00e9rifiez et r\u00e9essayez.',
      'err.key.fail': 'La validation de la cl\u00e9 a \u00e9chou\u00e9. V\u00e9rifiez et r\u00e9essayez.',
      'err.passkey.fail': 'L\u2019authentification par passkey a \u00e9chou\u00e9. Essayez le mot de passe.',
      'err.passkey.https': 'Les passkeys n\u00e9cessitent un contexte s\u00e9curis\u00e9 (HTTPS).',
      'err.passkey.setup': 'Impossible de configurer la passkey. Vous pourrez en ajouter une dans les Param\u00e8tres.',
      'err.lockout': 'Trop de tentatives. R\u00e9essayez dans',

      'ok.created': 'Compte cr\u00e9\u00e9\u00a0!',
      'ok.key': 'Cl\u00e9 valid\u00e9e\u00a0! Connexion\u2026',
      'ok.passkey': 'Passkey ajout\u00e9e\u00a0! Redirection\u2026',
      'ok.passkey.exists': 'Passkey d\u00e9j\u00e0 enregistr\u00e9e\u00a0! Redirection\u2026',
      'ok.redirect': 'Redirection\u2026',
    },

    // ═══════════════════════════════════════
    // ARABIC
    // ═══════════════════════════════════════
    ar: {
      'sub.language': '\u0627\u062e\u062a\u0631 \u0644\u063a\u062a\u0643',
      'sub.loading': '\u062c\u0627\u0631\u064a \u0627\u0644\u062a\u062d\u0642\u0642\u2026',
      'sub.login': '\u0633\u062c\u0651\u0644 \u0627\u0644\u062f\u062e\u0648\u0644 \u0644\u0644\u0645\u062a\u0627\u0628\u0639\u0629',
      'sub.bootstrap': '\u0623\u0646\u0634\u0626 \u062d\u0633\u0627\u0628 \u0627\u0644\u0645\u0633\u0624\u0648\u0644',
      'sub.plan': '\u0643\u064a\u0641 \u062a\u0631\u064a\u062f \u0627\u0633\u062a\u062e\u062f\u0627\u0645 \u0627\u0644\u0630\u0643\u0627\u0621 \u0627\u0644\u0627\u0635\u0637\u0646\u0627\u0639\u064a\u061f',
      'sub.provider': '\u0627\u0631\u0628\u0637 \u0645\u0632\u0648\u062f \u0627\u0644\u0630\u0643\u0627\u0621 \u0627\u0644\u0627\u0635\u0637\u0646\u0627\u0639\u064a',
      'sub.passkey': '\u0645\u0631\u062d\u0628\u064b\u0627 \u0628\u0639\u0648\u062f\u062a\u0643!',

      'login.email': '\u0627\u0644\u0628\u0631\u064a\u062f \u0627\u0644\u0625\u0644\u0643\u062a\u0631\u0648\u0646\u064a',
      'login.email.ph': 'you@example.com',
      'login.password': '\u0643\u0644\u0645\u0629 \u0627\u0644\u0645\u0631\u0648\u0631',
      'login.password.ph': '\u0623\u062f\u062e\u0644 \u0643\u0644\u0645\u0629 \u0627\u0644\u0645\u0631\u0648\u0631',
      'login.submit': '\u062a\u0633\u062c\u064a\u0644 \u0627\u0644\u062f\u062e\u0648\u0644',
      'login.passkey': '\u062a\u0633\u062c\u064a\u0644 \u0627\u0644\u062f\u062e\u0648\u0644 \u0628\u0645\u0641\u062a\u0627\u062d \u0627\u0644\u0645\u0631\u0648\u0631',
      'login.or': '\u0623\u0648',

      'reg.name': '\u0627\u0644\u0627\u0633\u0645 \u0627\u0644\u0645\u0639\u0631\u0648\u0636',
      'reg.name.ph': '\u0627\u0633\u0645\u0643',
      'reg.email': '\u0627\u0644\u0628\u0631\u064a\u062f \u0627\u0644\u0625\u0644\u0643\u062a\u0631\u0648\u0646\u064a',
      'reg.email.ph': 'you@example.com',
      'reg.password': '\u0643\u0644\u0645\u0629 \u0627\u0644\u0645\u0631\u0648\u0631',
      'reg.password.ph': '\u0627\u062e\u062a\u0631 \u0643\u0644\u0645\u0629 \u0645\u0631\u0648\u0631 \u0642\u0648\u064a\u0629',
      'reg.confirm': '\u062a\u0623\u0643\u064a\u062f \u0643\u0644\u0645\u0629 \u0627\u0644\u0645\u0631\u0648\u0631',
      'reg.confirm.ph': '\u0623\u0643\u0651\u062f \u0643\u0644\u0645\u0629 \u0627\u0644\u0645\u0631\u0648\u0631',
      'reg.submit': '\u0625\u0646\u0634\u0627\u0621 \u062d\u0633\u0627\u0628 \u0627\u0644\u0645\u0633\u0624\u0648\u0644',

      'plan.own.title': '\ud83d\udd11 \u0627\u0633\u062a\u062e\u062f\u0645 \u0645\u0641\u062a\u0627\u062d\u0643 \u0627\u0644\u062e\u0627\u0635',
      'plan.own.desc': '\u0627\u0633\u062a\u062e\u062f\u0645 \u0627\u0634\u062a\u0631\u0627\u0643\u0643 \u0641\u064a OpenAI \u0623\u0648 Google Gemini \u0623\u0648 Anthropic Claude. \u062a\u062f\u0641\u0639 \u0645\u0642\u0627\u0628\u0644 \u0627\u0633\u062a\u0647\u0644\u0627\u0643\u0643 \u0645\u0628\u0627\u0634\u0631\u0629.',
      'plan.own.tag': '\u0628\u062f\u0648\u0646 \u062d\u0635\u0635',
      'plan.hosted.title': '\ud83c\udf9f\ufe0f \u0627\u0633\u062a\u062e\u062f\u0645 \u0627\u0644\u0630\u0643\u0627\u0621 \u0627\u0644\u0645\u0633\u062a\u0636\u0627\u0641',
      'plan.hosted.desc': '\u0627\u0633\u062a\u062e\u062f\u0645 \u0631\u0645\u0648\u0632 \u0647\u0630\u0647 \u0627\u0644\u0645\u0646\u0635\u0629 \u0627\u0644\u0645\u0634\u062a\u0631\u0643\u0629. \u0628\u062f\u0627\u064a\u0629 \u0633\u0631\u064a\u0639\u0629 \u2014 \u0644\u0627 \u062d\u0627\u062c\u0629 \u0644\u0645\u0641\u062a\u0627\u062d API. \u062a\u064f\u0637\u0628\u0651\u0642 \u062d\u0635\u0635 \u0627\u0644\u0627\u0633\u062a\u062e\u062f\u0627\u0645.',
      'plan.hosted.tag': '\u062c\u0627\u0647\u0632 \u0644\u0644\u0627\u0633\u062a\u062e\u062f\u0627\u0645',
      'plan.hint': '\u064a\u0645\u0643\u0646\u0643 \u062a\u063a\u064a\u064a\u0631 \u0647\u0630\u0627 \u0644\u0627\u062d\u0642\u064b\u0627 \u0641\u064a \u0627\u0644\u0625\u0639\u062f\u0627\u062f\u0627\u062a.',

      'prov.openai': 'OpenAI',
      'prov.openai.desc': 'GPT-4o, o1, Codex',
      'prov.anthropic': 'Anthropic',
      'prov.anthropic.desc': 'Claude Opus, Sonnet, Haiku',
      'prov.google': 'Google',
      'prov.google.desc': 'Gemini Pro, Gemini Flash',
      'prov.key.label': '\u0645\u0641\u062a\u0627\u062d API',
      'prov.validate': '\u062a\u062d\u0642\u0642 \u0648\u062d\u0641\u0638',
      'prov.back': '\u062a\u063a\u064a\u064a\u0631 \u0627\u0644\u0645\u0632\u0648\u062f \u2192',
      'prov.skip': '\u0633\u0623\u0636\u064a\u0641\u0647 \u0644\u0627\u062d\u0642\u064b\u0627 \u0641\u064a \u0627\u0644\u0625\u0639\u062f\u0627\u062f\u0627\u062a',

      'prov.hint.openai': 'sk-\u2026 \u064a\u0628\u062f\u0623 \u0628\u0640 \u2014 \u0627\u062d\u0635\u0644 \u0639\u0644\u064a\u0647 \u0645\u0646 platform.openai.com/api-keys',
      'prov.hint.anthropic': 'sk-ant-\u2026 \u064a\u0628\u062f\u0623 \u0628\u0640 \u2014 \u0627\u062d\u0635\u0644 \u0639\u0644\u064a\u0647 \u0645\u0646 console.anthropic.com/settings/keys',
      'prov.hint.google': '\u0627\u062d\u0635\u0644 \u0639\u0644\u064a\u0647 \u0645\u0646 aistudio.google.com/apikey',

      'pk.title': '\ud83d\udd10 \u0625\u0636\u0627\u0641\u0629 \u0645\u0641\u062a\u0627\u062d \u0645\u0631\u0648\u0631\u061f',
      'pk.desc': '\u0633\u062c\u0651\u0644 \u0627\u0644\u062f\u062e\u0648\u0644 \u0623\u0633\u0631\u0639 \u0641\u064a \u0627\u0644\u0645\u0631\u0629 \u0627\u0644\u0642\u0627\u062f\u0645\u0629 \u0628\u0627\u0633\u062a\u062e\u062f\u0627\u0645 Face ID \u0623\u0648 Touch ID \u0623\u0648 \u0645\u0641\u062a\u0627\u062d \u0627\u0644\u0623\u0645\u0627\u0646.',
      'pk.setup': '\u0625\u0639\u062f\u0627\u062f',
      'pk.skip': '\u0644\u064a\u0633 \u0627\u0644\u0622\u0646',

      'loading.text': '\u062c\u0627\u0631\u064a \u0627\u0644\u0627\u062a\u0635\u0627\u0644\u2026',

      'footer.text': '\u0645\u0624\u0645\u0651\u0646 \u0628\u0648\u0627\u0633\u0637\u0629',
      'footer.fork': '\u0645\u0634\u062a\u0642 \u0645\u0646',

      'err.email': '\u064a\u0631\u062c\u0649 \u0625\u062f\u062e\u0627\u0644 \u0628\u0631\u064a\u062f\u0643 \u0627\u0644\u0625\u0644\u0643\u062a\u0631\u0648\u0646\u064a.',
      'err.password': '\u064a\u0631\u062c\u0649 \u0625\u062f\u062e\u0627\u0644 \u0643\u0644\u0645\u0629 \u0627\u0644\u0645\u0631\u0648\u0631.',
      'err.name': '\u064a\u0631\u062c\u0649 \u0625\u062f\u062e\u0627\u0644 \u0627\u0633\u0645 \u0627\u0644\u0639\u0631\u0636.',
      'err.email.reg': '\u064a\u0631\u062c\u0649 \u0625\u062f\u062e\u0627\u0644 \u0639\u0646\u0648\u0627\u0646 \u0628\u0631\u064a\u062f \u0625\u0644\u0643\u062a\u0631\u0648\u0646\u064a.',
      'err.password.choose': '\u064a\u0631\u062c\u0649 \u0627\u062e\u062a\u064a\u0627\u0631 \u0643\u0644\u0645\u0629 \u0645\u0631\u0648\u0631.',
      'err.password.short': '\u064a\u062c\u0628 \u0623\u0646 \u062a\u062d\u062a\u0648\u064a \u0643\u0644\u0645\u0629 \u0627\u0644\u0645\u0631\u0648\u0631 \u0639\u0644\u0649 8 \u0623\u062d\u0631\u0641 \u0639\u0644\u0649 \u0627\u0644\u0623\u0642\u0644.',
      'err.password.match': '\u0643\u0644\u0645\u062a\u0627 \u0627\u0644\u0645\u0631\u0648\u0631 \u063a\u064a\u0631 \u0645\u062a\u0637\u0627\u0628\u0642\u062a\u064a\u0646.',
      'err.connection': '\u062a\u0639\u0630\u0651\u0631 \u0627\u0644\u0627\u062a\u0635\u0627\u0644 \u0628\u0627\u0644\u062e\u0627\u062f\u0645. \u062a\u062d\u0642\u0642 \u0645\u0646 \u0627\u062a\u0635\u0627\u0644\u0643.',
      'err.login.fail': '\u0628\u0631\u064a\u062f \u0625\u0644\u0643\u062a\u0631\u0648\u0646\u064a \u0623\u0648 \u0643\u0644\u0645\u0629 \u0645\u0631\u0648\u0631 \u063a\u064a\u0631 \u0635\u062d\u064a\u062d\u0629.',
      'err.retry': '\u0641\u0634\u0644 \u0627\u0644\u0627\u062a\u0635\u0627\u0644. \u064a\u0631\u062c\u0649 \u0627\u0644\u0645\u062d\u0627\u0648\u0644\u0629 \u0645\u0631\u0629 \u0623\u062e\u0631\u0649.',
      'err.key.empty': '\u064a\u0631\u062c\u0649 \u0625\u062f\u062e\u0627\u0644 \u0645\u0641\u062a\u0627\u062d API.',
      'err.key.short': '\u0647\u0630\u0627 \u0627\u0644\u0645\u0641\u062a\u0627\u062d \u0642\u0635\u064a\u0631 \u062c\u062f\u064b\u0627. \u062a\u062d\u0642\u0642 \u0648\u0623\u0639\u062f \u0627\u0644\u0645\u062d\u0627\u0648\u0644\u0629.',
      'err.key.fail': '\u0641\u0634\u0644 \u0627\u0644\u062a\u062d\u0642\u0642 \u0645\u0646 \u0627\u0644\u0645\u0641\u062a\u0627\u062d. \u062a\u062d\u0642\u0642 \u0648\u0623\u0639\u062f \u0627\u0644\u0645\u062d\u0627\u0648\u0644\u0629.',
      'err.passkey.fail': '\u0641\u0634\u0644\u062a \u0627\u0644\u0645\u0635\u0627\u062f\u0642\u0629 \u0628\u0645\u0641\u062a\u0627\u062d \u0627\u0644\u0645\u0631\u0648\u0631. \u062c\u0631\u0651\u0628 \u0643\u0644\u0645\u0629 \u0627\u0644\u0645\u0631\u0648\u0631.',
      'err.passkey.https': '\u0645\u0641\u0627\u062a\u064a\u062d \u0627\u0644\u0645\u0631\u0648\u0631 \u062a\u062a\u0637\u0644\u0628 \u0627\u062a\u0635\u0627\u0644\u064b\u0627 \u0622\u0645\u0646\u064b\u0627 (HTTPS).',
      'err.passkey.setup': '\u062a\u0639\u0630\u0651\u0631 \u0625\u0639\u062f\u0627\u062f \u0645\u0641\u062a\u0627\u062d \u0627\u0644\u0645\u0631\u0648\u0631. \u064a\u0645\u0643\u0646\u0643 \u0625\u0636\u0627\u0641\u062a\u0647 \u0644\u0627\u062d\u0642\u064b\u0627 \u0641\u064a \u0627\u0644\u0625\u0639\u062f\u0627\u062f\u0627\u062a.',
      'err.lockout': '\u0645\u062d\u0627\u0648\u0644\u0627\u062a \u0643\u062b\u064a\u0631\u0629. \u0623\u0639\u062f \u0627\u0644\u0645\u062d\u0627\u0648\u0644\u0629 \u062e\u0644\u0627\u0644',

      'ok.created': '\u062a\u0645 \u0625\u0646\u0634\u0627\u0621 \u0627\u0644\u062d\u0633\u0627\u0628!',
      'ok.key': '\u062a\u0645 \u0627\u0644\u062a\u062d\u0642\u0642 \u0645\u0646 \u0627\u0644\u0645\u0641\u062a\u0627\u062d! \u062c\u0627\u0631\u064a \u0627\u0644\u0627\u062a\u0635\u0627\u0644\u2026',
      'ok.passkey': '\u062a\u0645\u062a \u0625\u0636\u0627\u0641\u0629 \u0645\u0641\u062a\u0627\u062d \u0627\u0644\u0645\u0631\u0648\u0631! \u062c\u0627\u0631\u064a \u0627\u0644\u062a\u062d\u0648\u064a\u0644\u2026',
      'ok.passkey.exists': '\u0645\u0641\u062a\u0627\u062d \u0627\u0644\u0645\u0631\u0648\u0631 \u0645\u0633\u062c\u0651\u0644 \u0645\u0633\u0628\u0642\u064b\u0627! \u062c\u0627\u0631\u064a \u0627\u0644\u062a\u062d\u0648\u064a\u0644\u2026',
      'ok.redirect': '\u062c\u0627\u0631\u064a \u0627\u0644\u062a\u062d\u0648\u064a\u0644\u2026',
    },

    // ═══════════════════════════════════════
    // ITALIAN
    // ═══════════════════════════════════════
    it: {
      'sub.language': 'Scegli la tua lingua',
      'sub.loading': 'Verifica in corso\u2026',
      'sub.login': 'Accedi per continuare',
      'sub.bootstrap': 'Crea il tuo account amministratore',
      'sub.plan': 'Come vuoi usare l\u2019IA?',
      'sub.provider': 'Collega il tuo provider AI',
      'sub.passkey': 'Bentornato!',

      'login.email': 'E-mail',
      'login.email.ph': 'tu@esempio.com',
      'login.password': 'Password',
      'login.password.ph': 'Inserisci la password',
      'login.submit': 'Accedi',
      'login.passkey': 'Accedi con Passkey',
      'login.or': 'o',

      'reg.name': 'Nome visualizzato',
      'reg.name.ph': 'Il tuo nome',
      'reg.email': 'E-mail',
      'reg.email.ph': 'tu@esempio.com',
      'reg.password': 'Password',
      'reg.password.ph': 'Scegli una password sicura',
      'reg.confirm': 'Conferma password',
      'reg.confirm.ph': 'Conferma la password',
      'reg.submit': 'Crea account admin',

      'plan.own.title': '\ud83d\udd11 Usa la tua chiave',
      'plan.own.desc': 'Usa il tuo abbonamento OpenAI, Google Gemini o Anthropic Claude. Paghi direttamente il tuo utilizzo.',
      'plan.own.tag': 'Senza limiti',
      'plan.hosted.title': '\ud83c\udf9f\ufe0f Usa l\u2019IA ospitata',
      'plan.hosted.desc': 'Usa i token condivisi di questa istanza. Partenza rapida \u2014 nessuna chiave API necessaria. Si applicano quote di utilizzo.',
      'plan.hosted.tag': 'Pronto all\u2019uso',
      'plan.hint': 'Puoi cambiare questa scelta pi\u00f9 tardi nelle Impostazioni.',

      'prov.openai': 'OpenAI',
      'prov.openai.desc': 'GPT-4o, o1, Codex',
      'prov.anthropic': 'Anthropic',
      'prov.anthropic.desc': 'Claude Opus, Sonnet, Haiku',
      'prov.google': 'Google',
      'prov.google.desc': 'Gemini Pro, Gemini Flash',
      'prov.key.label': 'Chiave API',
      'prov.validate': 'Convalida e salva',
      'prov.back': '\u2190 Cambia provider',
      'prov.skip': 'Lo aggiunger\u00f2 dopo nelle Impostazioni',

      'prov.hint.openai': 'Inizia con sk-\u2026 \u2014 ottienila su platform.openai.com/api-keys',
      'prov.hint.anthropic': 'Inizia con sk-ant-\u2026 \u2014 ottienila su console.anthropic.com/settings/keys',
      'prov.hint.google': 'Ottienila su aistudio.google.com/apikey',

      'pk.title': '\ud83d\udd10 Aggiungere una Passkey?',
      'pk.desc': 'Accedi pi\u00f9 velocemente la prossima volta con Face ID, Touch ID o la tua chiave di sicurezza.',
      'pk.setup': 'Configura',
      'pk.skip': 'Non ora',

      'loading.text': 'Connessione\u2026',

      'footer.text': 'Protetto da',
      'footer.fork': 'fork di',

      'err.email': 'Inserisci la tua e-mail.',
      'err.password': 'Inserisci la tua password.',
      'err.name': 'Inserisci un nome visualizzato.',
      'err.email.reg': 'Inserisci un indirizzo e-mail.',
      'err.password.choose': 'Scegli una password.',
      'err.password.short': 'La password deve contenere almeno 8 caratteri.',
      'err.password.match': 'Le password non corrispondono.',
      'err.connection': 'Impossibile raggiungere il server. Controlla la connessione.',
      'err.login.fail': 'E-mail o password non validi.',
      'err.retry': 'Connessione fallita. Riprova.',
      'err.key.empty': 'Inserisci la tua chiave API.',
      'err.key.short': 'Questa chiave sembra troppo corta. Controlla e riprova.',
      'err.key.fail': 'Convalida della chiave fallita. Controlla e riprova.',
      'err.passkey.fail': 'Autenticazione passkey fallita. Prova con la password.',
      'err.passkey.https': 'Le passkey richiedono un contesto sicuro (HTTPS).',
      'err.passkey.setup': 'Impossibile configurare la passkey. Puoi aggiungerne una nelle Impostazioni.',
      'err.lockout': 'Troppi tentativi. Riprova tra',

      'ok.created': 'Account creato!',
      'ok.key': 'Chiave convalidata! Connessione\u2026',
      'ok.passkey': 'Passkey aggiunta! Reindirizzamento\u2026',
      'ok.passkey.exists': 'Passkey gi\u00e0 registrata! Reindirizzamento\u2026',
      'ok.redirect': 'Reindirizzamento\u2026',
    },
  };

  /**
   * Get current language
   */
  function getLang() {
    return currentLang;
  }

  /**
   * Set current language
   */
  function setLang(lang) {
    if (translations[lang]) {
      currentLang = lang;
    }
  }

  /**
   * Translate a key to current language (falls back to English)
   */
  function t(key) {
    var dict = translations[currentLang] || translations.en;
    return dict[key] || (translations.en[key]) || key;
  }

  /**
   * Apply translations to all DOM elements with data-i18n attributes.
   *
   * Supported attributes:
   *   data-i18n="key"       → sets textContent
   *   data-i18n-ph="key"    → sets placeholder
   *   data-i18n-html="key"  → sets innerHTML
   *   data-i18n-aria="key"  → sets aria-label
   */
  function applyI18n(lang) {
    if (lang) setLang(lang);

    // Text content
    var els = document.querySelectorAll('[data-i18n]');
    for (var i = 0; i < els.length; i++) {
      var key = els[i].getAttribute('data-i18n');
      if (key) els[i].textContent = t(key);
    }

    // Placeholders
    var phs = document.querySelectorAll('[data-i18n-ph]');
    for (var j = 0; j < phs.length; j++) {
      var phKey = phs[j].getAttribute('data-i18n-ph');
      if (phKey) phs[j].placeholder = t(phKey);
    }

    // innerHTML
    var htmlEls = document.querySelectorAll('[data-i18n-html]');
    for (var k = 0; k < htmlEls.length; k++) {
      var htmlKey = htmlEls[k].getAttribute('data-i18n-html');
      if (htmlKey) htmlEls[k].innerHTML = t(htmlKey);
    }

    // aria-label
    var ariaEls = document.querySelectorAll('[data-i18n-aria]');
    for (var l = 0; l < ariaEls.length; l++) {
      var ariaKey = ariaEls[l].getAttribute('data-i18n-aria');
      if (ariaKey) ariaEls[l].setAttribute('aria-label', t(ariaKey));
    }
  }

  // Expose globally
  window.I18N = {
    translations: translations,
    t: t,
    getLang: getLang,
    setLang: setLang,
    applyI18n: applyI18n
  };

})();
