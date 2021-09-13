import {
  Commitment,
  Connection,
  PublicKey,
  Keypair,
  Transaction,
  TransactionSignature,
} from "@solana/web3.js";
import {
  getMintDecimals,
  findAssociatedTokenAccount,
  getTokenBalance,
} from "./utils";
import { MarketOptions } from "./types/market";
import { MarketState } from "./state";
import { DEX_ID, SRM_MINT, MSRM_MINT } from "./ids";
import { EventQueue, OrderbookState } from "@bonfida/aaob";
import { getFeeTier } from "./fees";

/**
 * A Serum DEX Market object
 */
export class Market {
  /** Market state
   * @private
   */
  private _marketState: MarketState;
  /** Asset agnostic orderbook state
   * @private
   */
  private _orderbookState: OrderbookState;
  /** Address of the Serum DEX market
   * @private
   */
  private _address: PublicKey;
  /** Number of decimals of the base token
   * @private
   */
  private _baseDecimals: number;
  /** Number of decimals of the quote token
   * @private
   */
  private _quoteDecimals: number;
  /** Serum program ID of the market
   * @private
   */
  private _programId: PublicKey;
  /** Preflight option (used in the connection object for sending tx)
   * @private
   */
  private _skipPreflight: boolean;
  /** Commitment option (used in the connection object)
   * @private
   */
  private _commitment: Commitment;

  constructor(
    marketState: MarketState,
    orderbookState: OrderbookState,
    address: PublicKey,
    baseDecimals: number,
    quoteDecimals: number,
    options: MarketOptions,
    programdId: PublicKey
  ) {
    this._marketState = marketState;
    this._orderbookState = orderbookState;
    this._address = address;
    this._baseDecimals = baseDecimals;
    this._quoteDecimals = quoteDecimals;
    this._skipPreflight = !!options.skipPreflight;
    this._commitment = options.commitment || "recent";
    this._programId = programdId;
  }

  static async load(
    connection: Connection,
    address: PublicKey,
    programId: PublicKey = DEX_ID,
    options: MarketOptions = {}
  ) {
    const marketState = await MarketState.retrieve(connection, address);

    const orderbookState = await OrderbookState.retrieve(
      connection,
      marketState.orderbook
    );

    const [baseDecimals, quoteDecimals] = await Promise.all([
      getMintDecimals(connection, marketState.baseMint),
      getMintDecimals(connection, marketState.quoteMint),
    ]);
    return new Market(
      marketState,
      orderbookState,
      address,
      baseDecimals,
      quoteDecimals,
      options,
      programId
    );
  }

  get programId(): PublicKey {
    return this._programId;
  }

  get address(): PublicKey {
    return this._address;
  }

  get baseMintAddress(): PublicKey {
    return this._marketState.baseMint;
  }

  get quoteMintAddress(): PublicKey {
    return this._marketState.quoteMint;
  }

  get bidsAddress(): PublicKey {
    return this._orderbookState.bids;
  }

  get asksAddress(): PublicKey {
    return this._orderbookState.asks;
  }

  get marketState(): MarketState {
    return this._marketState;
  }

  get orderbookState(): OrderbookState {
    return this._orderbookState;
  }

  async loadBids(connection: Connection) {
    const bids = await this._orderbookState.loadBidsSlab(connection);
    return bids;
  }

  async loadAsks(connection: Connection) {
    const asks = await this._orderbookState.loadAsksSlab(connection);
    return asks;
  }

  async loadOrdersForOwner() {}

  filterForOpenOrders() {}

  async findBaseTokenAccountsForOwner(owner: PublicKey) {
    const pubkey = await findAssociatedTokenAccount(
      owner,
      this._marketState.baseMint
    );
    return pubkey;
  }

  async findQuoteTokenAccountsForOwner(owner: PublicKey) {
    const pubkey = await findAssociatedTokenAccount(
      owner,
      this._marketState.quoteMint
    );
    return pubkey;
  }

  async findOpenOrdersAccountForOwner(owner: PublicKey) {
    const [address] = await PublicKey.findProgramAddress(
      [this.address.toBuffer(), owner.toBuffer()],
      this.programId
    );
    return address;
  }

  async placeOrder() {}

  /**
   * This method returns the fee discount keys assuming (M)SRM tokens are held in associated token account.
   * @param connection The solana connection object to the RPC node
   * @param owner The public key of the (M)SRM owner
   * @returns An array of `{ pubkey: PublicKey, mint: PublicKey, balance: number, feeTier: number }`
   */
  async findFeeDiscountKeys(connection: Connection, owner: PublicKey) {
    const [srmAddress, msrmAddress] = await Promise.all(
      [SRM_MINT, MSRM_MINT].map((e) => findAssociatedTokenAccount(owner, e))
    );
    const [srmBalance, msrmBalance] = await Promise.all(
      [srmAddress, msrmAddress].map((e) => getTokenBalance(connection, e))
    );
    return [
      {
        pubkey: srmAddress,
        mint: SRM_MINT,
        balance: srmBalance,
        feeTier: getFeeTier(0, srmBalance),
      },
      {
        pubkey: msrmAddress,
        mint: MSRM_MINT,
        balance: msrmBalance,
        feeTier: getFeeTier(msrmBalance, 0),
      },
    ];
  }

  async makePlaceOrderTransaction() {}

  makePlaceOrderInstruction() {}

  private async _sendTransaction(
    connection: Connection,
    transaction: Transaction,
    signers: Array<Keypair>
  ): Promise<TransactionSignature> {
    const signature = await connection.sendTransaction(transaction, signers, {
      skipPreflight: this._skipPreflight,
    });
    const { value } = await connection.confirmTransaction(
      signature,
      this._commitment
    );
    if (value?.err) {
      throw new Error(JSON.stringify(value.err));
    }
    return signature;
  }

  async cancelOrderByClientId() {}

  async settleFunds() {}

  async loadEventQueue(connection: Connection) {
    const eventQueue = await EventQueue.load(
      connection,
      this._orderbookState.eventQueue
    );
    return eventQueue;
  }

  async loadFills() {}
}