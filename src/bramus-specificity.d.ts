declare module "@bramus/specificity" {
  export default class Specificity {
    static calculate(selector: string | object): Specificity[];
    static calculateForAST(selectorAST: object): Specificity;
    toArray(): [number, number, number];
    toString(): string;
  }
}
