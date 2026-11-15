// Player profile strings (nickname + player code). Kept apart from en.ts/fr.ts like the Lab's, so the profile can ship
// as a lazy chunk. Every key exists in both languages (typed).
import { translator, type Lang } from "../i18n/index.ts";

const en = {
  "profile.open": "Profile",
  "profile.title": "Your player profile",
  "profile.lead": "No account, no password: your progress lives on this device. A player code carries it to another phone or computer.",
  "profile.name": "Nickname",
  "profile.namePh": "Shown on your share card",
  "profile.nameSaved": "Saved.",
  "profile.code.h": "Your player code",
  "profile.code.fine": "Copy it, save it as a file or send yourself the link, then open it on the other device. Anyone with the code can copy your progress, so keep it to yourself.",
  "profile.code.make": "Create my code",
  "profile.code.copy": "Copy code",
  "profile.code.copied": "Code copied.",
  "profile.code.file": "Save as file",
  "profile.code.link": "Copy link",
  "profile.code.linkCopied": "Link copied. Open it on the other device.",
  "profile.import.h": "Bring progress here",
  "profile.import.fine": "Paste a player code or link from another device. It is merged with what is already here: nothing is lost.",
  "profile.import.ph": "PM1.…",
  "profile.import.go": "Import",
  "profile.import.fromLink": "A player code came with this link. Import it into this device?",
  "profile.import.ok": "Imported: {days} days and {moments} moments merged.",
  "profile.import.format": "That doesn't look like a player code. Check you copied all of it.",
  "profile.import.version": "This code comes from a newer version of Playmaker. Reload the page and try again.",
  "profile.import.corrupt": "The code is damaged (a character changed or is missing). Copy it again.",
  "profile.close": "Close",
  "profile.stats": "{days} days played · {moments} moments on this device",
} as const;

export type ProfileKey = keyof typeof en;

const fr: Record<ProfileKey, string> = {
  "profile.open": "Profil",
  "profile.title": "Votre profil de joueur",
  "profile.lead": "Pas de compte, pas de mot de passe : votre progression reste sur cet appareil. Un code joueur la transporte vers un autre téléphone ou ordinateur.",
  "profile.name": "Pseudo",
  "profile.namePh": "Affiché sur votre carte de partage",
  "profile.nameSaved": "Enregistré.",
  "profile.code.h": "Votre code joueur",
  "profile.code.fine": "Copiez-le, enregistrez-le dans un fichier ou envoyez-vous le lien, puis ouvrez-le sur l'autre appareil. Toute personne qui a le code peut copier votre progression : gardez-le pour vous.",
  "profile.code.make": "Créer mon code",
  "profile.code.copy": "Copier le code",
  "profile.code.copied": "Code copié.",
  "profile.code.file": "Enregistrer le fichier",
  "profile.code.link": "Copier le lien",
  "profile.code.linkCopied": "Lien copié. Ouvrez-le sur l'autre appareil.",
  "profile.import.h": "Récupérer une progression",
  "profile.import.fine": "Collez un code joueur ou un lien venant d'un autre appareil. Il est fusionné avec ce qui est déjà ici : rien n'est perdu.",
  "profile.import.ph": "PM1.…",
  "profile.import.go": "Importer",
  "profile.import.fromLink": "Ce lien contient un code joueur. L'importer sur cet appareil ?",
  "profile.import.ok": "Importé : {days} jours et {moments} moments fusionnés.",
  "profile.import.format": "Ce n'est pas un code joueur. Vérifiez que vous l'avez copié en entier.",
  "profile.import.version": "Ce code vient d'une version plus récente de Playmaker. Rechargez la page et réessayez.",
  "profile.import.corrupt": "Le code est abîmé (un caractère a changé ou manque). Copiez-le à nouveau.",
  "profile.close": "Fermer",
  "profile.stats": "{days} jours joués · {moments} moments sur cet appareil",
};

export const PROFILE_DICTS: Record<Lang, Record<ProfileKey, string>> = { en, fr };
export const { t: pt } = translator<ProfileKey>(PROFILE_DICTS);
