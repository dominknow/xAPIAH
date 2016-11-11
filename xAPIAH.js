/**
 * Implements the logic for multi-player xAPI Against Humanity
 * 
 * @author Edgar Acosta
 * 
 * Assumes the hosting course uses TinCan, is connected to an LRS, and it knows
 * the actor and course activity id.
 */
var AH;
(function () {
    "use strict";
    AH = function (gameState) {
        // implements the API exposed to the course
        this.cards = null;
        this.dataSource = null;
        this.state = null;
        this.init(gameState);
    };
    AH.prototype = {
        init : function (gameState) {
            if (typeof gameState === "undefined" || gameState == null) {
                this.state = {
                    turn : 0,
                    cards : null,
                    api : {
                        player : 0,
                        registration : null,
                        sentences : {},
                        players : {
                            ids : [],
                            count : 0,
                            agents : [],
                            timerId : null
                        }
                    }
                };
            } else {
                this.state = gameState;
            }
            this.dealer = new AH.Cards(this.state.cards);
            this.api = new AH.DataSource(this.state.api);
        },
        /**
         * Function to be used at first to join the game and prepare the cards
         * 
         * @param {AH~setupOnSuccess}
         *            callback - function to call when we successfully join a
         *            room
         * @param {AH~setupOnError}
         *            onError - function to call when there is an error joining
         *            a room
         */
        setupGame : function (callback, onError) {
            var self = this;
            var onSuccess = function (players) {
                self.dealer.setupGame();
                self.state.turn = 1;
                callback(players);
            };
            this.api.joinAH(onSuccess, onError);
        },
        /**
         * Used when exiting the lobby to start the game
         */
        startGame : function () {
            this.api.stopPollingPlayers();
            this.api.checkAndCloseRoom();
        },
        getAllPlayers : function () {
            this.getState();
            return this.state.api.players.agents;
        },
        /**
         * Returns the verb and noun cards that can be used
         * 
         * @returns {object} - {verb: string, nouns: string[]}
         */
        getQuestionCards : function () {
            return this.dealer.getQuestionCards(this.state.turn);
        },
        /**
         * Submits a formed sentence and updates the cards available for next
         * question
         * 
         * @param {string}
         *            subject - the noun selected as subject
         * @param {string}
         *            object - the noun selected as object
         */
        submitSentence : function (subject, object, callback) {
            var objectId = this.dealer.getNounId(object);
            this.api.sendSentence(subject, this.dealer
                    .getQuestionVerb(this.state.turn), object, objectId,
                    callback);
            this.dealer.discardNouns([ subject, object ]);
        },
        /**
         * Retrieves all the sentences created for a question by all players in
         * the same room
         * 
         * @param {AH~foundSentencesCallback}
         *            callback - the function to call when we are done, or get
         *            an error
         */
        getSubmittedSentences : function (callback) {
            this.api.startPollingSentencesByVerb(this.dealer
                    .getQuestionVerb(this.state.turn), callback);
        },
        /**
         * method used to submit a vote
         * 
         * @param {string}
         *            stmtId - the id of the statement associated with the
         *            sentence voted for
         * @param {string}
         *            sentence - the string representation of the sentence (as
         *            received by AH~foundSentencesCallback)
         */
        submitVote : function (stmtId, sentence) {
            // A user can submit a null vote if they have nothing to vote on
            // except for their own sentence (which is not allowed). This
            // progresses the game while awarding no vote points from the
            // submitted player for that turn
            if (stmtId) {
                this.api.submitVote(stmtId, sentence);
            }
            this.state.turn++; // this ends the game turn
        },
        /**
         * Retrieves the 5 top (most voted) sentences on this room
         * 
         * @param {AH~topCallback}
         *            callback - the function to be called with the results
         */
        getTopSentences : function (callback) {
            this.api.fetchTopSentences(callback);
        },
        /**
         * Returns the game state so that we can keep carry it forwards to the
         * next page
         */
        getState : function () {
            var cards = this.dealer.getNounCards();
            var apiState = this.api.getState();
            this.state.cards = cards;
            this.state.api = apiState;
            return this.state;
        }
    };
}());
AH.events = {
    userJoined : "AH_USER_JOINED",
    newSentence : "AH_NEW_SENTENCE",
    readyToVote : "AH_CAN_VOTE"
};
(function () {
    "use strict";
    /*
     * Implements the operations that involve communication with the LRS
     */
    var ExpApiDataSource = AH.DataSource = function (apiState) {
        this.maxGetRoomAttempts = 6;
        this.getRoomAttempts = 0;
        this.mySubmittedSentences = {};
        this.player = 0;
        this.openRooms = [];
        this.room = null;
        this.roomPlayers = {
            ids : [],
            count : 0,
            agents : [],
            timerId : null
        };
        this.registration = null;
        this.createStmtId = null;
        this.joinedStmtId = null;
        this.doAfterJoin = null;
        this.doAfterJoinError = null;
        this.fetchEnd = null;
        this.fetchCallback = null;
        this.foundSentenceIds = [];
        this.votes = {};
        this.verbs = {
            created : {
                id : "http://dominknow.com/expapi/verbs/createdRoom",
                display : {
                    "en-US" : "created"
                }
            },
            joined : {
                id : "http://dominknow.com/expapi/verbs/joinedRoom",
                display : {
                    "en-US" : "joined"
                }
            },
            played : {
                id : "http://dominknow.com/expapi/verbs/createdSentence",
                display : {
                    "en-US" : "created sentence"
                }
            },
            voted : {
                id : "http://dominknow.com/expapi/verbs/votedSentence",
                display : {
                    "en-US" : "+1 for sentence"
                }
            }
        };
        this.init(apiState);
    };
    ExpApiDataSource.prototype = {
        init : function (apiState) {
            this.clearRegistration(apiState);
            this.doAfterJoin = null;
            this.doAfterJoinError = null;
            this.mySubmittedSentences = apiState.sentences;
        },
        clearRegistration : function (apiState) {
            this.player = apiState.player;
            this.openRooms = [];
            this.room = null;
            this.roomPlayers = apiState.players;
            this.registration = apiState.registration;
            this.createStmtId = null;
            this.joinedStmtId = null;
        },
        getState : function () {
            var state = {
                player : this.player,
                registration : this.registration,
                sentences : JSON.parse(JSON
                        .stringify(this.mySubmittedSentences)),
                players : JSON.parse(JSON.stringify(this.roomPlayers))
            };
            return state;
        },
        /**
         * Function to be used at first to join the game
         * 
         * @param callback function to call when we successfully join a room
         * @param onError function to call when there is an error joining a room
         */
        joinAH : function (callback, onError) {
            tincan.actor.mbox = tincan.actor.mbox.toLowerCase();
            // prevents http errors related to tincan from blowing on your face.
            tincan.recordStores[0].alertOnRequestFailure = false; 
            this.clearRegistration(this.getState());
            this.doAfterJoin = callback;
            this.doAfterJoinError = onError;
            this.mySubmittedSentences = {};
            this.getRoom();
        },
        getRoom : function () {
            this.getRoomAttempts++;
            this.getOpenRoom();
        },
        getOpenRoom : function () {
            var self = this;
            var myCallback = function (err, res) {
                self.onOpenRoomResponse(err, res);
            };
            var cfg = {
                params : {
                    verb : this.verbs.created,
                    ascending : true
                },
                sendActivity : false,
                sendRegistration : false,
                callback : myCallback
            };
            // this returns a TinCan.StatementsResult object
            this.getRoomStatements(cfg);
        },
        onOpenRoomResponse : function (err, res) {
            if (err !== null) {
                return this.throwJoinError("Error looking up an open room: ",
                        err, res);
            }
            this.addOpenRooms(this.filterStatementsByVerb(this.verbs.created,
                    res.statements));
            if (res.hasOwnProperty("more") && res.more) {
                var self = this;
                var moreCallback = function (err, res) {
                    self.onOpenRoomResponse(err, res);
                };
                this.fetchMoreStatements(res.more, moreCallback);
            } else {
                this.checkOpenRooms();
            }
        },
        addOpenRooms : function (statements) {
            if(!statements){
                return;
            }
            for (var i = 0; i < statements.length; i++) {
                var room = {
                    room : JSON.parse(statements[i].originalJSON).object,
                    createStmtId : statements[i].id,
                    registration : statements[i].context.registration
                };
                this.openRooms.push(room);
            }
        },
        checkOpenRooms: function() {
            if (this.openRooms.length == 0) {
                return this.createRoom();
            }
            // pick the first open room
            var room = this.openRooms.shift();
            this.room = room.room;
            this.createStmtId = room.createStmtId;
            this.registration = room.registration;
            this.findSpotOnRoom();
        },
        createRoom : function () {
            this.player = 1;
            this.registration = this.getUUID();
            this.room = {
                objectType : "Activity",
                id : "http://dominknow/expapi/room/" + this.registration,
                definition : {
                    name : {
                        "und" : "Room " + this.registration
                    }
                }
            };
            // prepare statements to create and join the room
            var join = {
                verb : this.verbs.joined,
                object : this.room,
                context : {
                    registration : this.registration,
                    contextActivities : null
                }
            };
            var create = {
                verb : this.verbs.created,
                object : this.room,
                context : {
                    registration : this.registration,
                    contextActivities : null
                }
            };
            // send statements
            var self = this;
            var myCallback = function (result) {
                self.onCreateRoom(result);
            };
            var result = tincan.sendStatements([ join, create ], myCallback);
        },
        onCreateRoom : function (results, stmts) {
            if (results[0].err !== null) {
                return this.throwJoinError("Cannot create a new game room: ",
                        results[0].err, results[0].xhr);
            }
            // get create room stmt id and return
            var stmtIds = JSON.parse(results[0].xhr.responseText);
            this.joinedtmtId = stmtIds[0];
            this.createStmtId = stmtIds[1];
            this.endJoin(); // we are done here, ready to play!
        },
        findSpotOnRoom : function () {
            var self = this;
            var spot = function () {
                self.confirmSpotOnRoom();
            }
            var handler = function (N) {
                if (N > 3) {
                    // sorry, room is full
                    self.onRoomFull(); // try again
                } else {
                    if(self.playerAlreadyInRoom()){
                        self.checkOpenRooms();
                    } else if (N > 2) {
                        // room is almost full
                        self.closeRoom(spot);
                    } else {
                        // ready to join
                        self.onSpotFound();
                    }
                }
            };
            this.getNumberOfPlayersInRoom(handler);
        },
        confirmSpotOnRoom : function () {
            var self = this;
            var handler = function (N) {
                if (N > 3) {
                    // sorry, room is full
                    self.onRoomFull(); // try again
                } else {
                    // ready to join
                    self.onSpotFound();
                }
            };
            this.getNumberOfPlayersInRoom(handler);
        },
        onRoomFull : function () {
            if (this.getRoomAttempts >= this.maxGetRoomAttempts) {
                return this.throwJoinError(
                        "We were unable to create or join a game.", null, {});
            }
            this.clearRegistration(this.getState());
            this.getRoom();
        },
        onSpotFound : function () {
            // we can join a room now
            this.joinRoom();
        },
        joinRoom : function () {
            var join = {
                verb : this.verbs.joined,
                object : this.room,
                context : {
                    registration : this.registration,
                    contextActivities : null
                }
            };
            var self = this;
            var myCallback = function (results, stmt) {
                self.onJoinedRoom(results, stmt);
            };
            tincan.sendStatement(join, myCallback);
        },
        onJoinedRoom : function (results, stmt) {
            // we need to save the id of the join statement
            var first = results[0];
            if (first.err !== null) {
                return this.throwJoinError("Error joining room: ", first.err,
                        first.xhr);
            }
            if (stmt.hasOwnProperty("id") && stmt.id) {
                this.joinedStmtId = stmt.id;
            } else {
                var ids = JSON.parse(first.xhr.responseText);
                this.joinedStmtId = ids[0];
            }
            // we now need to find our player number
            var self = this;
            var myCallback = function (err, result) {
                self.getMyPlayerNumber(err, result);
            };
            this.getPlayersInRoom(myCallback);
        },
        getMyPlayerNumber : function (err, result) {
            if (err !== null) {
                return this.throwJoinError(
                        "Cannot get players that joined a room: ", err, result);
            }
            for (var j = 0; j < result.statements.length; j++) {
                if (result.statements[j].id == this.joinedStmtId) {
                    this.player = j + 1;
                    this.onPlayerNumberFound();
                    break;
                }
            }
            // if we got to this point is because we didn't find our join room
            // statement.
            // TODO: we should retry.
        },
        onPlayerNumberFound : function () {
            if (this.player > 3) {
                this.checkAndCloseRoom();
            }
            this.endJoin();
        },
        endJoin : function () {
            var self = this;
            var setRoomPlayers = function (err, result) {
                if (err !== null) {
                    return self.throwJoinError(
                            "Cannot get players that joined a room: ", err,
                            result);
                }
                self.roomPlayers.count = result.statements.length;
                for (var j = 0; j < result.statements.length; j++) {
                    var agent = result.statements[j].actor;
                    agent.icon = self.getAgentIcon(agent);
                    if (agent.mbox == tincan.actor.mbox) {
                        self.roomPlayers.agents.unshift(agent);
                        self.roomPlayers.ids.unshift(agent.mbox);
                    } else {
                        self.roomPlayers.agents.push(agent);
                        self.roomPlayers.ids.push(agent.mbox);
                    }
                }
                self.afterJoin();
            };
            this.getPlayersInRoom(setRoomPlayers);
        },
        afterJoin : function () {
            if (typeof this.doAfterJoin === "function") {
                var callback = this.doAfterJoin;
                this.doAfterJoin = null;
                callback(this.roomPlayers.agents);
            } else {
                // triger the user joined event for each player in the room
                this.triggerUserJoinedEvent();
            }
            // last keep polling for new players in the room
            if (this.roomPlayers.count > 3) {
                return;
            }
            var self = this;
            var pollRoomPlayersCallback = function () {
                self.pollRoomPlayers();
            }
            this.roomPlayers.timerId = setInterval(pollRoomPlayersCallback,
                    1000);
        },
        getAgentIcon : function (agent) {
            var email = agent.mbox.replace("mailto:", "");
            return gravatar(email, {
                size : 64,
                rating : "pg",
                backup : "identicon"
            });
        },
        triggerUserJoinedEvent : function () {
            var event = new CustomEvent(AH.events.userJoined, {
                detail : this.roomPlayers.agents,
                bubbles : true,
                cancelable : true
            });
            document.dispatchEvent(event);
        },
        pollRoomPlayers : function () {
            var self = this;
            var findRoomPlayers = function (err, result) {
                if (err !== null) {
                    return self.throwJoinError(
                            "Cannot get players that joined a room: ", err,
                            result);
                }
                if (self.roomPlayers.count >= result.statements.length) {
                    return;
                }
                self.roomPlayers.count = result.statements.length;
                for (var j = 0; j < result.statements.length; j++) {
                    var agent = result.statements[j].actor;
                    if (self.roomPlayers.ids.indexOf(agent.mbox) < 0) {
                        // we found a new player, we need to add her and trigger
                        // an event
                        agent.icon = self.getAgentIcon(agent);
                        if (agent.mbox == tincan.actor.mbox) {
                            self.roomPlayers.agents.unshift(agent);
                            self.roomPlayers.ids.unshift(agent.mbox);
                        } else {
                            self.roomPlayers.agents.push(agent);
                            self.roomPlayers.ids.push(agent.mbox);
                        }
                        self.triggerUserJoinedEvent();
                    }
                }
            };
            this.getPlayersInRoom(findRoomPlayers);
        },
        stopPollingPlayers : function () {
            if (this.roomPlayers.timerId) {
                clearInterval(this.roomPlayers.timerId);
                this.roomPlayers.timerId = null;
            }
        },
        getNumberOfPlayersInRoom : function (callback) {
            this.lastFoundPlayersInRoom = [];
            var self = this;
            var getNumber = function (err, result) {
                if (err !== null) {
                    return self.throwJoinError(
                            "Cannot get players that joined a room: ", err,
                            result);
                }
                self.lastFoundPlayersInRoom = result.statements;
                callback(result.statements.length);
            };
            this.getPlayersInRoom(getNumber);
        },
        playerAlreadyInRoom: function() {
            for(var i=0; i < this.lastFoundPlayersInRoom.length; i++) {
                if(tincan.actor.mbox == this.lastFoundPlayersInRoom[i].actor.mbox){
                    return true;
                }
            }
            return false;
        },
        getPlayersInRoom : function (callback) {
            var cfg = {
                params : {
                    registration : this.registration, // this identifies the
                                                        // room
                    verb : this.verbs.joined,
                    // related_activities: true,
                    ascending : true
                // this is useful to find the player number
                },
                sendActivity : false,
                callback : callback
            };
            // this returns a TinCan.StatementsResult object
            tincan.getStatements(cfg);
        },
        closeRoom : function (callback) {
            if (this.createStmtId !== null) {
                tincan.voidStatement(this.createStmtId, callback, {});
            } else {
                callback();
            }
        },
        checkAndCloseRoom : function () {
            if (tincan.version === "0.9" || tincan.version === "0.95") {
                this.closeRoom(this.emptyCallback);
            } else if (this.createStmtId !== null) {
                var self = this;
                var myCallback = function (err, result) {
                    self.onCheckClosedRoom(err, result);
                }
                tincan.getVoidedStatement(this.createStmtId, myCallback);
            }
        },
        onCheckClosedRoom : function (err, result) {
            if (err === 404) {
                // the room is not closed, we need to close it
                this.closeRoom(this.emptyCallback);
            } else if (err !== null) {
                return this.throwJoinError("Error looking up closed room", err,
                        result);
            }
        },
        /**
         * Handles the submission xAPI statements when a user submits her cards
         * for a given game verb.
         * 
         * @param subject is the value of the first white card @param verb is
         * the value of the game verb in the question @param object is the value
         * of the second white card
         */
        sendSentence : function (subject, verb, object, objectid, callback) {
            // we need to submit the sentence on its own statement, and then
            // submit an statement indicating we submitted the sentence
            var gameVerb = this.makeVerb(verb);
            var sentence = [ subject, verb, object ].join(" ");
            var data = {
                actor : {
                    objectType : "Agent",
                    name : subject,
                    account : {
                        homePage : "http://dominknow/expapi/ah",
                        name : subject
                    }
                },
                verb : gameVerb,
                object : {
                    id : "http://dominknow/expapi/ah/" + objectid,
                    objectType : "Activity",
                    definition : {
                        name : {
                            "en-US" : object
                        }
                    }
                },
                context : {
                    registration : this.registration,
                    contextActivities : null
                },
                result : {
                    response : sentence
                }
            };
            var self = this;
            var myCallback = function (results, stmt) {
                self.onSentenceSent(results, stmt, gameVerb.id, sentence);
                callback();
            }
            tincan.sendStatement(data, myCallback);
        },
        onSentenceSent : function (results, stmt, verbId, sentence) {
            var first = results[0];
            if (first.err !== null) {
                return this.throwError("Cannot submit formed sentence: ",
                        first.err, first.xhr);
            }
            // first.xhr has the statement id
            var stmtId;
            if (stmt.hasOwnProperty("id") && stmt.id) {
                stmtId = stmt.id;
            } else {
                var ids = JSON.parse(first.xhr.responseText);
                stmtId = ids[0];
            }
            this.mySubmittedSentences[this.extractSimpleVerb(verbId)] = {
                id : stmtId,
                stmt : stmt,
                sentence : sentence
            };
            this.attributeSentence(stmtId, sentence);
        },
        attributeSentence : function (stmtId, sentence) {
            var player = tincan.actor.name || ("Player " + this.player);
            var msg = player + " played '" + sentence + "'";
            var data = {
                verb : this.verbs.played,
                object : {
                    objectType : "StatementRef",
                    id : stmtId,
                    display : sentence
                },
                context : {
                    registration : this.registration,
                    contextActivities : null
                },
                result : {
                    response : msg
                }
            };
            tincan.sendStatement(data);
        },
        /**
         * Retrieves the sentences submitted by all players in the room waiting
         * for other player submissions if necessary
         * 
         * @param string verb the game verb we need to fetch for voting @param
         * function callback the function to call when we are done, or get an
         * error
         */
        startPollingSentencesByVerb : function (verb, callback) {
            var verbObj = this.makeVerb(verb);
            this.foundSentenceIds = [];
            // we already know which sentence we submitted, so we can add it
            var mySentence = {
                id : this.mySubmittedSentences[verb].id,
                sentence : this.mySubmittedSentences[verb].sentence,
                agent : this.roomPlayers.agents[0],
                countdown : 30
            };
            this.fireFoundSentenceEvent(mySentence);
            this.foundSentenceIds.push(mySentence.id);
            // now poll for other sentences in the room
            this.fetchEnd = 29000 + (new Date().getTime());
            var self = this;
            var pollSentences = function () {
                self.findSentencesByVerb(verbObj);
            };
            this.pollSentencesTimerId = setInterval(pollSentences, 1000);
            if (typeof callback === "function") {
                callback(this.pollSentencesTimerId);
            }
        },
        fireFoundSentenceEvent : function (sentence) {
            var event = new CustomEvent(AH.events.newSentence, {
                detail : sentence,
                bubbles : true,
                cancelable : true
            });
            document.dispatchEvent(event);
        },
        findSentencesByVerb : function (verbObj) {
            var self = this;
            var myCallback = function (error, result) {
                if (error !== null) {
                    clearInterval(self.pollSentencesTimerId);
                    return self
                            .throwError(
                                    "Cannot fetch sentences by all players in the room: ",
                                    error, result);
                }
                self.onSentencesFound(verbObj, result);
            };
            var cfg = {
                params : {
                    registration : this.registration,
                    verb : verbObj
                },
                callback : myCallback
            };
            tincan.getStatements(cfg);
        },
        onSentencesFound : function (verb, result) {
            var attribution = this.filterStatementsByVerb(this.verbs.played,
                    result.statements);
            if (attribution.length > this.foundSentenceIds.length) {
                // got new sentences, figure out which one and fire events
                var statements = this.filterStatementsByVerb(verb,
                        result.statements);
                this.detectNewSentences(attribution, statements);
            }
            var now = new Date().getTime();
            if (this.foundSentenceIds.length >= this.roomPlayers.count
                    || now >= this.fetchEnd) {
                // if we have found one sentence per player in the room or ran
                // for too long
                clearInterval(this.pollSentencesTimerId); // stop polling
                var event = new CustomEvent(AH.events.readyToVote, {
                    detail : true,
                    bubbles : true,
                    cancelable : true
                });
                document.dispatchEvent(event);
            }
        },
        detectNewSentences : function (attribution, statements) {
            for (var i = 0; i < attribution.length; i++) {
                var attrib = attribution[i];
                var stmtId = attrib.target.id;
                if (this.foundSentenceIds.indexOf(stmtId) > -1) {
                    // this sentence is already reported
                    continue;
                }
                // we've found a new sentence
                var author = this.findPlayerByActor(attrib.actor);
                var sentence = this.extractSentenceByStmtId(statements, stmtId);
                var timeLeft = this.fetchEnd - (new Date().getTime());
                timeLeft = (timeLeft - (timeLeft % 1000)) / 1000;
                var payload = {
                    id : stmtId,
                    sentence : sentence,
                    agent : author,
                    countdown : timeLeft
                };
                this.fireFoundSentenceEvent(payload);
                this.foundSentenceIds.push(stmtId);
            }
        },
        extractSentenceByStmtId : function (statements, id) {
            for (var i = 0; i < statements.length; i++) {
                if (statements[i].id == id) {
                    return statements[i].result.response;
                }
            }
            return "Sentence not found";
        },
        filterStatementsByVerb : function (verb, statements) {
            var checkVerb = function (stmt) {
                return stmt.verb.id == verb.id;
            }
            return statements.filter(checkVerb);
        },
        extractSimpleVerb : function (verbId) {
            var res = verbId.replace(/https?:\/\/.+\/([^\/]+)/, "$1");
            return res;
        },
        /**
         * method used to submit a vote
         * 
         * @param string
         *            stmtId the id of the statement associated with the
         *            sentence voted for
         * @param string
         *            sentence the string representation of the sentence
         */
        submitVote : function (stmtId, sentence) {
            var cfg = {
                verb : this.verbs.voted,
                object : {
                    objectType : "StatementRef",
                    id : stmtId,
                    display : sentence
                },
                context : {
                    registration : this.registration,
                    contextActivities : null
                },
                result : {
                    response : sentence
                }
            };
            tincan.sendStatement(cfg, this.emptyCallback);
        },
        /**
         * Retrieves the 5 top (most voted) sentences in this game
         * 
         * @param function
         *            callback the function to be called with the results
         */
        fetchTopSentences : function (callback) {
            this.votes = {};
            var cfg = {
                params : {
                    registration : this.registration,
                    verb : this.verbs.voted
                },
                callback : this.makeVotesCallback(callback)
            };
            tincan.getStatements(cfg);
        },
        makeVotesCallback : function (callback) {
            var self = this;
            var response = function (error, result) {
                if (error !== null) {
                    return callback({
                        err : self
                                .formatError(
                                        "Cannot fetch votes by all players in the room: ",
                                        error, result)
                    });
                }
                self.onFoundVotes(result, callback);
            };
            return response;
        },
        onFoundVotes : function (result, callback) {
            this.addVotes(result.statements);
            if (result.hasOwnProperty("more") && result.more) {
                // there are more results. Go fetch them
                var moreCallback = this.makeVotesCallback(callback);
                this.fetchMoreStatements(result.more, moreCallback);
            } else {
                // we get here once we retrieved all of the votes. it is time to
                // count and filter
                this.findWinners(this.computeTopSentences(), callback);
            }
        },
        addVotes : function (stmts) {
            // add votes to this.votes based on the voting statements
            for (var i = 0; i < stmts.length; i++) {
                var stmtId = stmts[i].target.id;
                if (this.votes.hasOwnProperty(stmtId)) {
                    this.votes[stmtId].count++;
                } else {
                    this.votes[stmtId] = {
                        count : 1,
                        sentence : stmts[i].result.response
                    };
                }
            }
        },
        fetchMoreStatements : function (url, moreCallback) {
            var lrs = tincan.recordStores[0];
            lrs.moreStatements({
                url : url,
                callback : moreCallback
            });
        },
        /**
         * finds the 5 sentences with the most votes
         * 
         * @returns array an array of up to 5 objects: {count: # of votes,
         * sentence: the sentence} ordered from more to less votes
         */
        computeTopSentences : function () {
            var countMap = {}; // maps a count result with all the stmt ids
                                // that got that number of votes
            var counts = []; // keeps the different numbers of votes (keys of
                                // countMap)
            for ( var id in this.votes) {
                if (this.votes.hasOwnProperty(id)) {
                    var count = this.votes[id].count;
                    if (countMap.hasOwnProperty(count)) {
                        countMap[count].push(id);
                    } else {
                        countMap[count] = [ id ];
                        counts.push(count);
                    }
                }
            }
            counts.sort(); // order the numbers of votes
            var topIds = []; // to store the top statement ids
            for (var i = 0; i < 5; i++) {
                var nextCount = counts.pop(); // get the next higher number of
                                                // votes
                if (typeof nextCount === "undefined") { // if there are very few
                                                        // different numbers of
                                                        // votes
                    break;
                }
                var ids = countMap[nextCount]; // get the ids of statements
                                                // with that number of votes
                for (var j = 0; j < ids.length; j++) { // add the respective
                                                        // sentences to the
                                                        // winners array.
                    topIds.push(ids[j]);
                    if (topIds.length >= 5) {
                        return topIds;
                    }
                }
            }
            // we only reach this point if we didn't find 5 winners
            return topIds;
        },
        findWinners : function (stmtIds, callback) {
            // we need to retrieve all the attribution statements in the room
            // and filter them by verb and referred stmt id
            this.winners = {};
            for (var i = 0; i < stmtIds.length; i++) {
                this.winners[stmtIds[i]] = this.votes[stmtIds[i]];
            }
            var cfg = {
                params : {
                    registration : this.registration,
                    verb : this.verbs.played
                },
                callback : this.makeWinnerCallback(stmtIds, callback)
            };
            tincan.getStatements(cfg);
        },
        makeWinnerCallback : function (stmtIds, callback) {
            var self = this;
            var response = function (error, result) {
                if (error !== null) {
                    var winners = self.winners;
                    return callback(stmtIds.map(function (stmtid) {
                        return winners[stmtid];
                    })); // return what we have without authors
                }
                self.onFoundAuthors(result, stmtIds, callback);
            };
            return response;
        },
        onFoundAuthors : function (result, stmtIds, callback) {
            this.addAuthors(stmtIds, result.statements);
            if (result.hasOwnProperty("more") && result.more) {
                // there are more results. Go fetch them
                var moreCallback = this.makeWinnerCallback(stmtIds, callback);
                this.fetchMoreStatements(result.more, moreCallback);
            } else {
                var winners = this.winners;
                // we get here once we retrieved all of the votes. it is time to
                // count and filter
                callback(stmtIds.map(function (stmtid) {
                    return winners[stmtid];
                }));
            }
        },
        addAuthors : function (stmtIds, stmts) {
            for (var i = 0; i < stmts.length; i++) {
                var stmtId = stmts[i].target.id;
                if (stmtIds.indexOf(stmtId) > -1) {
                    this.winners[stmtId].author = this
                            .findPlayerByActor(stmts[i].actor);
                }
            }
        },
        throwJoinError : function (msg, err, obj) {
            this.clearRegistration(this.getState());
            this.doAfterJoin = null;
            msg = this.formatError(msg, err, obj);
            if (this.doAfterJoinError === null) {
                throw msg;
            }
            callback = this.doAfterJoinError;
            this.doAfterJoinError = null;
            callback();
        },
        throwError : function (msg, err, obj) {
            //this.clearRegistration();
            this.doAfterJoin = null;
            msg = this.formatError(msg, err, obj);
            if (this.doAfterJoinError === null) {
                throw msg;
            }
            callback = this.doAfterJoinError;
            this.doAfterJoinError = null;
            callback();
        },
        /**
         * Returns the player agent object for a sentence actor
         * if the actor is not a player, we add it
         */
        findPlayerByActor : function (actor) {
            var mbox = actor.mbox;
            if (this.roomPlayers.ids.indexOf(mbox) < 0) {
                //this is a player we didn't know about
                actor.icon = this.getAgentIcon(actor);
                this.roomPlayers.ids.push(mbox);
                this.roomPlayers.agents.push(actor);
                return actor;
            }
            for (var i = 0; i < this.roomPlayers.agents.length; i++) {
                if (this.roomPlayers.agents[i].mbox == mbox) {
                    return this.roomPlayers.agents[i];
                }
            }
        },
        emptyCallback : function () {
            //used to make sure all xapi calls are asynchronous when we don't actually need a callback
        },
        makeVerb : function (verb) {
            return {
                id : this.makeVerbId(verb),
                display : {
                    "en-US" : verb
                }
            }
        },
        makeVerbId : function (verb) {
            var prefix = "http://dominknow.com/expapi/verbs/";
            return prefix + encodeURI(verb);
        },
        formatError : function (msg, err, obj) {
            if (obj.hasOwnProperty("responseText")) {
                msg = msg + obj.responsetText;
                if (obj.hasOwnProperty("statusText")) {
                    msg = msg + "\n" + obj.statusText;
                }
            } else { //this happens when err is an exception
                msg = msg + err;
            }
            return msg;
        },
        getUUID : function () {
            return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g,
                    function (c) {
                        var r = Math.random() * 16 | 0, v = c == "x" ? r
                                : (r & 0x3 | 0x8);
                        return v.toString(16);
                    });
        },
        getRoomStatements : function (cfg) {
            tincan.log("getRoomStatements");
            var queryCfg = {}, lrs, params, msg;
            if (tincan.recordStores.length > 0) {
                lrs = tincan.recordStores[0];
                cfg = cfg || {};
                params = cfg.params || {};
                if (cfg.sendActor && tincan.actor !== null) {
                    if (lrs.version === "0.9" || lrs.version === "0.95") {
                        params.actor = tincan.actor;
                    } else {
                        params.agent = tincan.actor;
                    }
                }
                if (cfg.sendActivity && tincan.activity !== null) {
                    if (lrs.version === "0.9" || lrs.version === "0.95") {
                        params.target = tincan.activity;
                    } else {
                        params.activity = tincan.activity;
                    }
                }
                if (cfg.sendRegistration
                        && typeof params.registration === "undefined"
                        && tincan.registration !== null) {
                    params.registration = tincan.registration;
                }
                queryCfg = {
                    params : params
                };
                if (typeof cfg.callback !== "undefined") {
                    queryCfg.callback = cfg.callback;
                }
                return lrs.queryStatements(queryCfg);
            }
            msg = "[warning] getStatements: No LRSs added yet (statements not read) ";
            tincan.log(msg);
        }
    };
}());
(function () {
    "use strict";
    /**
     * Shuffles and assign cards 
     */
    var AHCards = AH.Cards = function (availableNouns) {
        this.verbs = [];
        this.nouns = [];
        this.myNouns = [];
        this.init(availableNouns);
    };
    AHCards.prototype = {
        init : function (availableNouns) {
            this.initVerbs();
            this.initNouns();
            this.prepareNouns(availableNouns);
        },
        prepareNouns : function (availableNouns) {
            if (availableNouns !== null) {
                this.myNouns = availableNouns;
            }
        },
        setupGame : function () {
            //select 10 random noun cards
            var nn = this.nouns.length;
            if (nn < 11) {
                this.myNouns = this.nouns.slice(0);
                return;
            }
            while (this.myNouns.length < 10) {
                var candidate = this.nouns[Math.floor(Math.random() * nn)];
                if (this.myNouns.indexOf(candidate) < 0) {
                    this.myNouns.push(candidate);
                }
            }
        },
        getQuestionVerb : function (question) {
            if ((!Number.isInteger(question)) || (question < 1 || question > 5)) {
                return null;
            }
            return this.verbs[question - 1];
        },
        getQuestionCards : function (question) {
            if ((!Number.isInteger(question)) || (question < 1 || question > 5)) {
                return null;
            }
            return {
                verb : this.getQuestionVerb(question),
                nouns : this.myNouns.slice(0)
            };
        },
        discardNouns : function (nouns) {
            for (var i = 0; i < nouns.length; i++) {
                var index = this.myNouns.indexOf(nouns[i]);
                if (index > -1) {
                    this.myNouns.splice(index, 1);
                }
            }
        },
        getNounCards : function () {
            return this.myNouns.slice(0);
        },
        getNounId : function (noun) {
            return 1 + this.nouns.indexOf(noun);
        },
        initVerbs : function () {
            this.verbs = [ "licked", "hurt", "punished", "used", "satisfied" ];
        },
        initNouns : function () {
            this.nouns = [
                    "Proving the link between training and performance",
                    "a 70% improvement in learning",
                    "foreclosure on my mother in laws home",
                    "a promotion to SVP, Latin America",
                    "$5 million return on investment",
                    "the end of the world as we know it",
                    "civilian casualities",
                    "crippling debt",
                    "natural selection",
                    "a 20% increase in sales",
                    "a lack of 508 compliance",
                    "a never-ending RFP",
                    "printing out 7 years of e-learning in braille for the blind guy",
                    "the prediction of an early death",
                    "oral herpes",
                    "remedial training for those with poor personal hygiene",
                    "a infinitely branching scenario",
                    "activity tracking my bowel movements",
                    "my zone of Proximal Development",
                    "the office intern",
                    "an adaptive learning system, that turned out to be Skynet",
                    "the talent management system and the criminal record checks",
                    "the top 10 list of 'learning thought leaders'",
                    "my metacognitive processes",
                    "the next presenter on stage",
                    "only from the waist down on a Skype call",
                    "research assistants",
                    "Indian outsourced development",
                    "5 year olds in a Skinner Box",
                    "my hierarchy of sexual needs",
                    "unnecessary amounts of cleavage for a stand-up meeting",
                    "sex, as an agile user journey",
                    "just-in-time gynecology training",
                    "Accenture, giving performance support tips on my honeymoon",
                    "a haptic feedback device, strapped to my genitals",
                    "your mom, whilst wearing the Oculus Rift",
                    "improving user acceptance results",
                    "me being single, again",
                    "a new definition of learning, which we all agree on forever",
                    "never sleeping again",
                    "mass redundancy",
                    "engaged learners",
                    "vomit",
                    "unexpected pregnancy",
                    "the internet never working again",
                    "a very big lawsuit",
                    "gun control",
                    "inappropriate use of the hole-in-the-wall computer",
                    "good times",
                    "organised fun",
                    "airing grievances",
                    "bums on seats",
                    "someone calling the fuzz",
                    "meeting my CPE requirements",
                    "a shift in politics to the left",
                    "winning the DemoFest",
                    "a drastic increase in knowledge retention",
                    "free lifetime membership to the E-learning Guild",
                    "podcasts for deaf people",
                    "a meaningful xAPI statement",
                    "selling the company to Skillsoft",
                    "becoming Facebook friends with your line manager",
                    "10,000 LinkedIn connections",
                    "auto-tweeting profanity",
                    "a distinct increase in the prison population",
                    "a lifetime enrolment to sexual harassment training",
                    "disappointingly low net promoter scores",
                    "a nervous breakdown",
                    "being escorted from the networking dinner",
                    "reverse brainstorming my last will and testament",
                    "a fresh smelling work environment",
                    "knowledge actually getting worse",
                    "my shattered confidence",
                    "T+D magazine no longer taking my calls",
                    "the make-a-wish foundation no longer wanting our companies sponsorship",
                    "a sticky keyboard",
                    "Bandon Hall Awards for everybody",
                    "batch uploading the employee database to North Korea",
                    "the no pants dance",
                    "a metric ton of illegible flip charts",
                    "on the team away day",
                    "the breakdown of transatlantic relations",
                    "using a meme incorrectly",
                    "a formal, written warning",
                    "Kirkpatrick's fifth level",
                    "with the HR director",
                    "everyone loving the change",
                    "standing up desks",
                    "no more board pens in the conference room",
                    "a management review of all training activities",
                    "the ball, in a WebEx conference",
                    "a transgender role-playing scenario",
                    "marital relations by employing the 70/20/10 framework in the bedroom",
                    "with the wireless mic turned on",
                    "safe harbour regulations",
                    "Marge, the cleaning lady",
                    "every muffin at the coffee table",
                    "whilst wearing Google Glasses",
                    "analytics that take account of time-spent on pron sites",
                    "Sal Khan",
                    "my annual performance review",
                    "A drag and drop puzzle, using the rotting carcass of Cecil the Lion as a background image",
                    "inappropriate peer feedback",
                    "a coaching session the  men's sauna",
                    "the forgetting curve",
                    "a face to face training session, using someone else's face as a mask",
                    "tantric sex as a group warm-up exercise",
                    "whatever the hell I want",
                    "the feedback of my passive aggressive manager",
                    "middle management",
                    "the lack of mute button for everyone else on this conference call",
                    "icebreakers", "another damn checkbox exercise",
                    "my completion status", "our brand guidelines",
                    "a jeopardy game", "my balls",
                    "a sexual suggestive Storyline activity", "the whiteboard",
                    "a wrist-slitting onboarding program",
                    "brutal truth telling",
                    "another fecking creativity exercise",
                    "my LMS administrator", "my smile sheet",
                    "Sir Ken Robinson", "whilst on a conference call",
                    "at the thought of action learning",
                    "the gratuitous use of comic sans",
                    "prostitution, disguised as kinesthetic learning",
                    "a short novel, passing as e-learning",
                    "racially questionable stock photos",
                    "the training needs analysis",
                    "a poorly conceived true or false question",
                    "Elliott Masie", "poorly judged clipart" ];
        }
    };
}());