export type Location = "storage" | "memory" | "calldata";
export type Visibility = "internal" | "external";
export type Mutability = "pure" | "view" | "nonpayable" | "payable";
export type ContractKind = "contract" | "library" | "interface";

export class UnknownUserDefinedTypeError extends Error {
  public typeString: string;
  public id: string;
  constructor(id: string, typeString: string) {
    const message = `Cannot locate definition for ${typeString} (ID ${id})`;
    super(message);
    this.name = "UnknownUserDefinedTypeError";
    this.id = id;
    this.typeString = typeString;
  }
}
