// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Test} from "forge-std/Test.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

import {NadCards} from "../src/NadCards.sol";

contract NadCardsTest is Test {
    NadCards private cards;

    address private alice;
    address private bob;
    address private arena;
    address private payee;

    function setUp() public {
        cards = new NadCards();
        alice = makeAddr("alice");
        bob = makeAddr("bob");
        arena = makeAddr("arena");
        payee = makeAddr("payee");
    }

    function test_freePull_mintsOncePerAddress() public {
        vm.prank(alice, alice);
        uint256 id = cards.freePull();
        assertEq(cards.ownerOf(id), alice);
        assertEq(cards.cardOf(alice), id);
        assertTrue(cards.hasPulled(alice));

        vm.prank(alice, alice);
        vm.expectRevert(NadCards.AlreadyPulled.selector);
        cards.freePull();
    }

    function test_freePull_rejectsContractCaller() public {
        vm.prank(address(this), alice); // msg.sender != tx.origin
        vm.expectRevert(NadCards.OnlyEOA.selector);
        cards.freePull();
    }

    function testFuzz_freePull_statsWithinRanges(uint256 rnd, address who) public {
        vm.assume(who != address(0) && who.code.length == 0);
        assumeNotPrecompile(who);
        assumeNotForgeAddress(who);
        vm.prevrandao(bytes32(rnd));
        vm.prank(who, who);
        NadCards.Card memory c = cards.cards(cards.freePull());
        assertLe(c.rarity, 3);
        assertLe(c.element, 2);
        assertGe(c.atk, 10 + c.rarity);
        assertLe(c.atk, 14 + c.rarity);
        assertGe(c.hp, 1500 + 100 * uint16(c.rarity));
        assertLe(c.hp, 1800 + 100 * uint16(c.rarity));
    }

    function test_recordResult_onlyArena() public {
        vm.expectRevert(NadCards.OnlyArena.selector);
        cards.recordResult(1, 2);
    }

    function test_recordResult_incrementsWinsAndLosses() public {
        // mint 2 kartu
        vm.prank(alice, alice);
        uint256 winId = cards.freePull();
        vm.prank(bob, bob);
        uint256 loseId = cards.freePull();

        cards.setArena(arena);
        vm.prank(arena);
        cards.recordResult(winId, loseId);

        assertEq(cards.cards(winId).wins, 1);
        assertEq(cards.cards(loseId).losses, 1);
    }

    function test_setArena_onlyOnce() public {
        cards.setArena(arena);
        vm.expectRevert(NadCards.ArenaAlreadySet.selector);
        cards.setArena(address(0xBEEF));
    }

    function test_paidPull_requiresExactPrice() public {
        vm.deal(alice, 1 ether);
        vm.prank(alice, alice);
        vm.expectRevert(NadCards.WrongPrice.selector);
        cards.paidPull{value: 0.01 ether}();
    }

    function test_paidPull_mintsNewActiveCardAndFillsTreasury() public {
        vm.deal(alice, 1 ether);
        vm.prank(alice, alice);
        uint256 first = cards.freePull();
        vm.prank(alice, alice);
        uint256 second = cards.paidPull{value: 0.05 ether}();
        assertEq(cards.cardOf(alice), second);
        assertEq(cards.ownerOf(first), alice);
        assertEq(address(cards).balance, 0.05 ether);
    }

    function test_withdraw_onlyOwner() public {
        vm.prank(bob);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, bob));
        cards.withdraw(payable(bob));

        // owner → seluruh saldo pindah ke `to` (pakai `Address.sendValue`)
        vm.deal(alice, 1 ether);
        vm.prank(alice, alice);
        cards.paidPull{value: 0.05 ether}();
        uint256 treasury = address(cards).balance;
        assertEq(treasury, 0.05 ether);

        uint256 before = payee.balance;
        cards.withdraw(payable(payee));
        assertEq(payee.balance, before + treasury);
        assertEq(address(cards).balance, 0);
    }

    function test_royalty_is_5_percent() public view {
        (address recv, uint256 amt) = cards.royaltyInfo(1, 1 ether);
        assertEq(recv, address(this));
        assertEq(amt, 0.05 ether);
    }

    // Extra coverage beyond the brief's list: the global constraint pins tokenURI
    // to baseURI + decimal token id (no ".json" suffix).
    function test_tokenURI_isBaseUriPlusDecimalTokenId() public {
        cards.setBaseURI("https://nadgacha.example/card/");
        vm.prank(alice, alice);
        uint256 id = cards.freePull();
        assertEq(cards.tokenURI(id), "https://nadgacha.example/card/1");
    }
}
