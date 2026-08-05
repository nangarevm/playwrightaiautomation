declare module "nspell" {
  interface Dictionary {
    aff: Buffer | string;
    dic: Buffer | string;
  }

  interface Nspell {
    correct(word: string): boolean;
    suggest(word: string): string[];
  }

  function nspell(dictionary: Dictionary): Nspell;
  export = nspell;
}
