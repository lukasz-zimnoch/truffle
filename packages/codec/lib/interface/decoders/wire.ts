import debugModule from "debug";
const debug = debugModule("codec:interface:decoders:wire");

import * as ConversionUtils from "@truffle/codec/utils/conversion";
import * as AbiUtils from "@truffle/codec/utils/abi";
import * as ContextUtils from "@truffle/codec/utils/contexts";
import * as MakeType from "@truffle/codec/utils/maketype";
import { abifyCalldataDecoding, abifyLogDecoding } from "@truffle/codec/utils/abify";;
import * as Utils from "@truffle/codec/utils/interface";
import * as Ast from "@truffle/codec/ast/types";
import * as Contexts from "@truffle/codec/contexts/types";
import * as Allocation from "@truffle/codec/allocate/types";
import * as Decoding from "@truffle/codec/decode/types";
import * as Evm from "@truffle/codec/evm";
import * as DecoderTypes from "../types";
import { Types } from "@truffle/codec/format";
import Web3 from "web3";
import { ContractObject } from "@truffle/contract-schema/spec";
import { Transaction } from "web3/eth/types";
import { Log } from "web3/types";
import { Provider } from "web3/providers";
import { getAbiAllocations, getCalldataAllocations, getEventAllocations } from "@truffle/codec/allocate/abi";
import { getStorageAllocations } from "@truffle/codec/allocate/storage";
import { decodeCalldata, decodeEvent } from "@truffle/codec/core/decoding";

export default class WireDecoder {
  private web3: Web3;

  private network: string;

  private contracts: DecoderTypes.ContractMapping = {};
  private contractNodes: Ast.AstNodes = {};
  private contexts: Contexts.DecoderContexts = {}; //all contexts
  private deployedContexts: Contexts.DecoderContexts = {};

  private referenceDeclarations: Ast.AstNodes;
  private userDefinedTypes: Types.TypesById;
  private allocations: Evm.Types.AllocationInfo;

  private codeCache: DecoderTypes.CodeCache = {};

  /**
   * @private
   */
  constructor(contracts: ContractObject[], provider: Provider) {

    this.web3 = new Web3(provider);

    let contractsAndContexts: DecoderTypes.ContractAndContexts[] = [];

    for(let contract of contracts) {
      let node: Ast.AstNode = Utils.getContractNode(contract);
      let deployedContext: Contexts.DecoderContext | undefined = undefined;
      let constructorContext: Contexts.DecoderContext | undefined = undefined;
      if(node !== undefined) {
        this.contracts[node.id] = contract;
        this.contractNodes[node.id] = node;
      }
      if(contract.deployedBytecode && contract.deployedBytecode !== "0x") {
        deployedContext = Utils.makeContext(contract, node);
        this.contexts[deployedContext.context] = deployedContext;
        //note that we don't set up deployedContexts until after normalization!
      }
      if(contract.bytecode && contract.bytecode !== "0x") {
        constructorContext = Utils.makeContext(contract, node, true);
        this.contexts[constructorContext.context] = constructorContext;
      }
      contractsAndContexts.push({contract, node, deployedContext, constructorContext});
    }

    this.contexts = <Contexts.DecoderContexts>ContextUtils.normalizeContexts(this.contexts);
    this.deployedContexts = Object.assign({}, ...Object.values(this.contexts).map(
      context => !context.isConstructor ? {[context.context]: context} : {}
    ));

    for(let contractAndContexts of contractsAndContexts) {
      //change everythign to normalized version
      if(contractAndContexts.deployedContext) {
        contractAndContexts.deployedContext = this.contexts[contractAndContexts.deployedContext.context]; //get normalized version
      }
      if(contractAndContexts.constructorContext) {
        contractAndContexts.constructorContext = this.contexts[contractAndContexts.constructorContext.context]; //get normalized version
      }
    }

    ({definitions: this.referenceDeclarations, types: this.userDefinedTypes} = this.collectUserDefinedTypes());

    let allocationInfo: Allocation.ContractAllocationInfo[] = contractsAndContexts.map(
      ({contract: { abi, compiler }, node, deployedContext, constructorContext}) => ({
        abi: AbiUtils.schemaAbiToAbi(abi),
        compiler,
        contractNode: node,
        deployedContext,
        constructorContext
      })
    );
    debug("allocationInfo: %O", allocationInfo);

    this.allocations = {};
    this.allocations.abi = getAbiAllocations(this.userDefinedTypes);
    this.allocations.storage = getStorageAllocations(this.referenceDeclarations, {}); //not used by wire decoder itself, but used by contract decoder
    this.allocations.calldata = getCalldataAllocations(allocationInfo, this.referenceDeclarations, this.userDefinedTypes, this.allocations.abi);
    this.allocations.event = getEventAllocations(allocationInfo, this.referenceDeclarations, this.userDefinedTypes, this.allocations.abi);
    debug("done with allocation");
  }

  private collectUserDefinedTypes(): {definitions: Ast.AstNodes, types: Types.TypesById} {
    let references: Ast.AstNodes = {};
    let types: Types.TypesById = {};
    for(const id in this.contracts) {
      const compiler = this.contracts[id].compiler;
      //first, add the contract itself
      const contractNode = this.contractNodes[id];
      references[id] = contractNode;
      types[id] = MakeType.definitionToStoredType(contractNode, compiler);
      //now, add its struct and enum definitions
      for(const node of contractNode.nodes) {
        if(node.nodeType === "StructDefinition" || node.nodeType === "EnumDefinition") {
          references[node.id] = node;
          //HACK even though we don't have all the references, we only need one:
          //the reference to the contract itself, which we just added, so we're good
          types[node.id] = MakeType.definitionToStoredType(node, compiler, references);
        }
      }
    }
    return {definitions: references, types};
  }

  //for internal use
  public async getCode(address: string, block: number): Promise<Uint8Array> {
    //first, set up any preliminary layers as needed
    if(this.codeCache[block] === undefined) {
      this.codeCache[block] = {};
    }
    //now, if we have it cached, just return it
    if(this.codeCache[block][address] !== undefined) {
      return this.codeCache[block][address];
    }
    //otherwise, get it, cache it, and return it
    let code = ConversionUtils.toBytes(
      await this.web3.eth.getCode(
        address,
        block
      )
    );
    this.codeCache[block][address] = code;
    return code;
  }

  //NOTE: additionalContexts parameter is for internal use only.
  public async decodeTransaction(transaction: Transaction, additionalContexts: Contexts.DecoderContexts = {}): Promise<DecoderTypes.DecodedTransaction> {
    debug("transaction: %O", transaction);
    const block = transaction.blockNumber;
    const context = await this.getContextByAddress(transaction.to, block, transaction.input, additionalContexts);

    const data = ConversionUtils.toBytes(transaction.input);
    const info: Evm.Types.EvmInfo = {
      state: {
        storage: {},
        calldata: data,
      },
      userDefinedTypes: this.userDefinedTypes,
      allocations: this.allocations,
      contexts: {...this.deployedContexts, ...additionalContexts},
      currentContext: context
    };
    const decoder = decodeCalldata(info);

    let result = decoder.next();
    while(result.done === false) {
      let request = result.value;
      let response: Uint8Array;
      switch(request.type) {
	case "code":
          response = await this.getCode(request.address, block);
	  break;
	//not writing a storage case as it shouldn't occur here!
      }
      result = decoder.next(response);
    }
    //at this point, result.value holds the final value
    const decoding = result.value;

    return {
      ...transaction,
      decoding
    };
  }

  //NOTE: options is meant for internal use; do not rely on it
  //NOTE: additionalContexts parameter is for internal use only.
  public async decodeLog(log: Log, options: DecoderTypes.EventOptions = {}, additionalContexts: Contexts.DecoderContexts = {}): Promise<DecoderTypes.DecodedLog> {
    const block = log.blockNumber;
    const data = ConversionUtils.toBytes(log.data);
    const topics = log.topics.map(ConversionUtils.toBytes);
    const info: Evm.Types.EvmInfo = {
      state: {
        storage: {},
        eventdata: data,
        eventtopics: topics
      },
      userDefinedTypes: this.userDefinedTypes,
      allocations: this.allocations,
      contexts: {...this.deployedContexts, ...additionalContexts}
    };
    const decoder = decodeEvent(info, log.address, options.name);

    let result = decoder.next();
    while(result.done === false) {
      let request = result.value;
      let response: Uint8Array;
      switch(request.type) {
	case "code":
          response = await this.getCode(request.address, block);
	  break;
	//not writing a storage case as it shouldn't occur here!
      }
      result = decoder.next(response);
    }
    //at this point, result.value holds the final value
    const decodings = result.value;

    return {
      ...log,
      decodings
    };
  }

  //NOTE: options is meant for internal use; do not rely on it
  //NOTE: additionalContexts parameter is for internal use only.
  public async decodeLogs(logs: Log[], options: DecoderTypes.EventOptions = {}, additionalContexts: Contexts.DecoderContexts = {}): Promise<DecoderTypes.DecodedLog[]> {
    return await Promise.all(logs.map(log => this.decodeLog(log, options, additionalContexts)));
  }

  //NOTE: additionalContexts parameter is for internal use only.
  public async events(options: DecoderTypes.EventOptions = {}, additionalContexts: Contexts.DecoderContexts = {}): Promise<DecoderTypes.DecodedLog[]> {
    let { address, name, fromBlock, toBlock } = options;

    const logs = await this.web3.eth.getPastLogs({
      address,
      fromBlock,
      toBlock,
    });

    let events = await this.decodeLogs(logs, options, additionalContexts);
    debug("events: %o", events);

    //if a target name was specified, we'll restrict to events that decoded
    //to something with that name.  (note that only decodings with that name
    //will have been returned from decodeLogs in the first place)
    if(name !== undefined) {
      events = events.filter(
        event => event.decodings.length > 0
      );
    }

    return events;
  }

  public abifyCalldataDecoding(decoding: Decoding.CalldataDecoding): Decoding.CalldataDecoding {
    return abifyCalldataDecoding(decoding, this.userDefinedTypes);
  }

  public abifyLogDecoding(decoding: Decoding.LogDecoding): Decoding.LogDecoding {
    return abifyLogDecoding(decoding, this.userDefinedTypes);
  }

  //normally, this function gets the code of the given address at the given block,
  //and checks this against the known contexts to determine the contract type
  //however, if this fails and constructorBinary is passed in, it will then also
  //attempt to determine it from that
  private async getContextByAddress(address: string, block: number, constructorBinary?: string, additionalContexts: Contexts.DecoderContexts = {}): Promise<Contexts.DecoderContext | null> {
    let code: string;
    if(address !== null) {
      code = ConversionUtils.toHexString(
        await this.getCode(address, block)
      );
    }
    else if(constructorBinary) {
      code = constructorBinary;
    }
    //if neither of these hold... we have a problem
    let contexts = {...this.contexts, ...additionalContexts};
    return ContextUtils.findDecoderContext(contexts, code);
  }

  //the following functions are intended for internal use only
  public getReferenceDeclarations(): Ast.AstNodes {
    return this.referenceDeclarations;
  }

  public getUserDefinedTypes(): Types.TypesById {
    return this.userDefinedTypes;
  }

  public getAllocations(): Evm.Types.AllocationInfo {
    return {
      abi: this.allocations.abi,
      storage: this.allocations.storage
    };
  }

  public getWeb3(): Web3 {
    return this.web3;
  }

  public getDeployedContexts(): Contexts.DecoderContexts {
    return this.deployedContexts;
  }
}
