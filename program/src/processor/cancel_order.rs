use std::rc::Rc;

use agnostic_orderbook::state::{
    get_side_from_order_id, EventQueue, EventQueueHeader, OrderSummary, Side,
};
use borsh::{BorshDeserialize, BorshSerialize};
use solana_program::{
    account_info::{next_account_info, AccountInfo},
    entrypoint::ProgramResult,
    msg,
    program::invoke_signed,
    program_error::ProgramError,
    pubkey::Pubkey,
};

use crate::{
    state::{DexState, UserAccount},
    utils::{check_account_key, check_signer},
};

#[derive(BorshDeserialize, BorshSerialize)]
/**
The required arguments for a create_market instruction.
*/
pub struct Params {
    order_index: u64,
}

#[derive(BorshDeserialize, BorshSerialize, Debug)]
pub enum OrderType {
    Limit,
    ImmediateOrCancel,
    FillOrKill,
    PostOnly,
}

struct Accounts<'a, 'b: 'a> {
    aaob_program: &'a AccountInfo<'b>,
    market: &'a AccountInfo<'b>,
    market_signer: &'a AccountInfo<'b>,
    orderbook: &'a AccountInfo<'b>,
    event_queue: &'a AccountInfo<'b>,
    bids: &'a AccountInfo<'b>,
    asks: &'a AccountInfo<'b>,
    user: &'a AccountInfo<'b>,
    user_owner: &'a AccountInfo<'b>,
}

impl<'a, 'b: 'a> Accounts<'a, 'b> {
    pub fn parse(
        _program_id: &Pubkey,
        accounts: &'a [AccountInfo<'b>],
    ) -> Result<Self, ProgramError> {
        let accounts_iter = &mut accounts.iter();
        let a = Self {
            aaob_program: next_account_info(accounts_iter)?,
            market: next_account_info(accounts_iter)?,
            market_signer: next_account_info(accounts_iter)?,
            orderbook: next_account_info(accounts_iter)?,
            event_queue: next_account_info(accounts_iter)?,
            bids: next_account_info(accounts_iter)?,
            asks: next_account_info(accounts_iter)?,
            user: next_account_info(accounts_iter)?,
            user_owner: next_account_info(accounts_iter)?,
        };
        check_signer(&a.user_owner).unwrap();

        Ok(a)
    }

    pub fn load_user_account(&self) -> Result<UserAccount<'b>, ProgramError> {
        let user_account = UserAccount::parse(&self.user)?;
        if &user_account.header.owner != self.user_owner.key {
            msg!("Invalid user account owner provided!");
            return Err(ProgramError::InvalidArgument);
        }
        if &user_account.header.market != self.market.key {
            msg!("The provided user account doesn't match the current market");
            return Err(ProgramError::InvalidArgument);
        };
        Ok(user_account)
    }
}

pub(crate) fn process(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
    params: Params,
) -> ProgramResult {
    let accounts = Accounts::parse(program_id, accounts)?;

    let Params { order_index } = params;

    let market_state =
        DexState::deserialize(&mut (&accounts.market.data.borrow() as &[u8]))?.check()?;

    let mut user_account = accounts.load_user_account()?;

    let mut market_data: &mut [u8] = &mut accounts.market.data.borrow_mut();
    market_state.serialize(&mut market_data).unwrap();

    check_accounts(program_id, &market_state, &accounts).unwrap();

    let order_id = user_account.read_order(order_index as usize)?;

    let cancel_order_instruction = agnostic_orderbook::instruction::cancel_order(
        *accounts.aaob_program.key,
        *accounts.orderbook.key,
        *accounts.market_signer.key,
        *accounts.event_queue.key,
        *accounts.bids.key,
        *accounts.asks.key,
        agnostic_orderbook::instruction::cancel_order::Params { order_id },
    );

    invoke_signed(
        &cancel_order_instruction,
        &[
            accounts.aaob_program.clone(),
            accounts.orderbook.clone(),
            accounts.event_queue.clone(),
            accounts.bids.clone(),
            accounts.asks.clone(),
            accounts.market_signer.clone(),
        ],
        &[&[
            &accounts.market.key.to_bytes(),
            &[market_state.signer_nonce],
        ]],
    )?;

    let event_queue_header =
        EventQueueHeader::deserialize(&mut (&accounts.event_queue.data.borrow() as &[u8]))?;
    let event_queue = EventQueue::new(
        event_queue_header,
        Rc::clone(&accounts.event_queue.data),
        32,
    );

    let order_summary: OrderSummary = event_queue.read_register().unwrap().unwrap();

    let side = get_side_from_order_id(order_id);

    match side {
        Side::Bid => {
            user_account.header.quote_token_free = user_account
                .header
                .quote_token_free
                .checked_add(order_summary.total_quote_qty)
                .unwrap();
            user_account.header.quote_token_locked = user_account
                .header
                .quote_token_locked
                .checked_sub(order_summary.total_quote_qty)
                .unwrap();
        }
        Side::Ask => {
            user_account.header.base_token_free = user_account
                .header
                .base_token_free
                .checked_add(order_summary.total_asset_qty)
                .unwrap();
            user_account.header.base_token_locked = user_account
                .header
                .base_token_locked
                .checked_sub(order_summary.total_asset_qty)
                .unwrap();
        }
    };

    user_account.remove_order(order_index as usize)?;

    user_account.write();

    Ok(())
}

fn check_accounts(
    program_id: &Pubkey,
    market_state: &DexState,
    accounts: &Accounts,
) -> ProgramResult {
    let market_signer = Pubkey::create_program_address(
        &[
            &accounts.market.key.to_bytes(),
            &[market_state.signer_nonce],
        ],
        program_id,
    )?;
    check_account_key(accounts.market_signer, &market_signer).unwrap();
    check_account_key(accounts.orderbook, &market_state.orderbook).unwrap();
    check_account_key(accounts.aaob_program, &market_state.aaob_program).unwrap();

    Ok(())
}