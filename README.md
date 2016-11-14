# xAPIAH
The goal is to demonstrate a possible use of xAPI.

We came up with the idea of creating a course that allows user play xAPI against humanity (based on the cards game by HT2).
We want to make it fun both for the course users, for the xAPI audience, and for us.
To make it more interesting, we decided to try and make it a multiplayer game.

## Gameplay overview
Users are invited to start the course/game.
A game is played by 4 players simultaneously (in the same "room")
* When the user launches the game (course)
  * the course looks up a room that still does not have 4 players (open room)
  * joins one such room or starts (and joins) a new one.
  * the course might show a screen indicating that we are entering the game room.
* Once a user joins a room, the course will provide 10 white cards
* On each of the following 5 rounds
  * the user is presented with a verb (the same, and same order, for all players) 
  * the user has to select 2 of her remaining white cards 
  * the user forms a sentence by placing one card before the verb and the other after the verb.
    * used cards cannot be used again.
  * when the user submits a sentence the course fires an xapi statement with it
  * the user is then presented with the sentences formed by the other players of the room.
  * the course might have to ask the user to wait for all players to submit their sentence for that verb
  * the user then selects the sentence that she finds the best (funniest)
  * when the user submits her vote, the course fires the xapi statement with the answer (so that it is displayed again each time a user votes for it)
* On the last screen we can  show the user the sentences that won for each verb
picking a random one in case of ties.

## How to use
* The game logic is implemented on the xAPIAH.js file
  * this library assumes that there is an instance of the low-level xAPI operations in variable tincan
* The examples folder includes one or more courses that use this library.
* Keep in mind that to run the examples you need an xAPI compliant LRS defined in file tc-config.js
