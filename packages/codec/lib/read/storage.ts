import debugModule from "debug";
const debug = debugModule("codec:read:storage");

import * as EvmUtils from "@truffle/codec/utils/evm";
import * as ConversionUtils from "@truffle/codec/utils/conversion";
import { slotAddressPrintout } from "@truffle/codec/utils/errors";
import * as Storage from "@truffle/codec/storage";
import * as Decoding from "@truffle/codec/decode/types";
import * as Evm from "@truffle/codec/evm";
import { DecodingError } from "@truffle/codec/decode/errors";
import BN from "bn.js";

/**
 * read slot from storage
 *
 * @param slot - see slotAddress() code to understand how these work
 * @param offset - for array, offset from the keccak determined location
 */
export function* read(storage: Evm.Types.WordMapping, slot: Storage.Types.Slot): Generator<Decoding.DecoderRequest, Uint8Array, Uint8Array> {
  debug("Slot printout: %s", slotAddressPrintout(slot));
  const address: BN = Storage.Utils.slotAddress(slot);

  // debug("reading slot: %o", ConversionUtils.toHexString(address));

  const hexAddress = ConversionUtils.toHexString(address, EvmUtils.WORD_SIZE);
  let word: Uint8Array = storage[hexAddress];

  //if we can't find the word in the map, we place a request to the invoker to supply it
  //(contract-decoder will look it up from the blockchain, while the debugger will just
  //say 0)
  if(word === undefined) {
    word = yield {
      type: "storage",
      slot: address
    };
  }

  return word;
}

/**
 * read all bytes in some range.
 *
 * parameters `from` and `to` are objects with the following properties:
 *
 *   slot - see the slotAddress() code to understand how these work
 *
 *     ref: https://solidity.readthedocs.io/en/v0.4.23/miscellaneous.html#layout-of-state-variables-in-storage
 *     (search "concatenation")
 *
 *  index - (default: 0) byte index in word
 *
 * @param from - location (see ^)
 * @param to - location (see ^). inclusive.
 * @param length - instead of `to`, number of bytes after `from`
 */
export function* readRange(storage: Evm.Types.WordMapping, range: Storage.Types.Range): Generator<Decoding.DecoderRequest, Uint8Array, Uint8Array> {
  debug("readRange %o", range);

  let { from, to, length } = range;

  from = {
    slot: from.slot,
    index: from.index || 0
  };

  if (length !== undefined) {
    to = {
      slot: {
        path: from.slot.path || undefined,
        offset: from.slot.offset.addn(
          Math.floor((from.index + length - 1) / EvmUtils.WORD_SIZE)
        )
      },
      index: (from.index + length - 1) % EvmUtils.WORD_SIZE
    };
  }

  debug("normalized readRange %o", {from,to});

  let totalWordsAsBN: BN = to.slot.offset.sub(from.slot.offset).addn(1);
  let totalWords: number;
  try {
    totalWords = totalWordsAsBN.toNumber();
  }
  catch(_) {
    throw new DecodingError({
      kind: "ReadErrorStorage" as const,
      range
    });
  }

  let data = new Uint8Array(totalWords * EvmUtils.WORD_SIZE);

  for (let i = 0; i < totalWords; i++) {
    let offset = from.slot.offset.addn(i);
    const word = yield* read(storage, { ...from.slot, offset });
    if (typeof word !== "undefined") {
      data.set(word, i * EvmUtils.WORD_SIZE);
    }
  }
  debug("words %o", data);

  data = data.slice(from.index, (totalWords - 1) * EvmUtils.WORD_SIZE + to.index + 1);

  debug("data: %o", data);

  return data;
}

