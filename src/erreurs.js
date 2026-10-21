/**
 * Refus de conformite.
 *
 * Classe isolee de tout acces a la base : elle est importee par le moteur de
 * baremes comme par les controles comptables, sans creer de dependance
 * circulaire entre eux.
 *
 * code    identifiant stable du refus, affiche a l'utilisateur et conserve
 *         dans la piste d'audit ;
 * details contexte exploitable par l'interface et par les etats de controle.
 */
export class ErreurConformite extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'ErreurConformite';
    this.code = code;
    this.details = details;
  }
}
