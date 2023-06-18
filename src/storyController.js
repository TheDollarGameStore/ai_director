const config = require("config");

const uri = config.mongoDb.connectionString.replace('<password>', config.mongoDb.password).replace('<username>', config.mongoDb.username);

const { MongoClient } = require("mongodb");
const client = new MongoClient(uri);

var generating = false;

var suggestTopic = async (req, res) => {
    try {
        await client.connect();

        var results = await client.db("Director").collection("proposed_topics").insertOne({
            requestor_id: req.body.requestor_id,
            priority: req.body.requestor_id == "system" ? -1 : 0,
            topic: req.body.topic,
            date: new Date()
        });

        if (res != null) {
            res.status(201).json({
                status: 'Success'
            });
        }
        else {
            return ;
        }
    }
    catch (e) {
        console.log(e);
        res.status(500).json({
            status: 'Failed',
            error: e
        });
    }
}

var generateStory = async () => {

    if (generating) {
        return ;
    }

    try {
        generating = true;
        await client.connect();

        //Check if there is already a generated topic, otherwise work on the next one
        var count = await client.db("Director").collection("generated_topics").countDocuments();

        if (count != 0) {
            generating = false;
            return ;
        }

        //Check if there are any proposed topics
        var count = await client.db("Director").collection("proposed_topics").countDocuments();

        if (count == 0) {
            generating = false;
            return ;
        }

        //Retrieve all
        var results = await client.db("Director").collection("proposed_topics").find().toArray();

        //Sort by priority
        results = results.sort((r1, r2) => (r1.priority < r2.priority) ? 1 : (r1.priority > r2.priority) ? -1 : 0);

        if (results.length != 0) {
            //If there are topics, grab the top priority one and send to chatGPT
            var request = {
                method: "POST",
                headers: {
                    "Content-Type":"application/json",
                    "Authorization": "Bearer " + config.chatGpt.secret
                },
                body: JSON.stringify({
                    model: "gpt-3.5-turbo",
                    messages: [
                        {
                            role: "user",
                            content: config.chatGpt.dialoguePrompt.replace("<topic>", results[0].topic)
                        }
                    ],
                    temperature: 0.7
                })
            };

            var response = await fetch("https://api.openai.com/v1/chat/completions", request);
            var jsonResponse = await response.json();
            var messages = processText(jsonResponse.choices[0].message.content);
            
            //Send through a generate voice request for all dialogues, then store the UId's and use them to poll
            var uid_array = [];
            
            for (var i = 0; i < messages.length; i++) {
                uid_array.push(await requestVoice(messages[i]));
            }
            
            var generatedSpeech = await pollSpeech(uid_array);

            //Amalgamate the chat completion response and generated speech urls
            var scenarios = [];

            for (var i = 0; i < messages.length; i++) {
                scenarios.push({
                    character: messages[i].character,
                    text: messages[i].dialogue,
                    sound: generatedSpeech[i].path
                });
            }

            await client.db("Director").collection("generated_topics").insertOne({
                requestor_id: results[0].requestor_id,
                topic: results[0].topic,
                scenario: scenarios
            });

            await client.db("Director").collection("proposed_topics").deleteOne({
                _id: results[0]._id
            });
        }
        generating = false;
    }
    catch (e) {
        generating = false;
        console.log(e);
    }
}

var getScenario = async (req, res) => {
    try {
        await client.connect();

        var results = await client.db("Director").collection("generated_topics").find().toArray();

        if (results.length > 0) {
            await client.db("Director").collection("generated_topics").deleteOne({
                _id: results[0]._id
            });

            res.status(200).json({
                ...results[0]
            });
        }
        else {
            res.status(204).json({
                status: "No Scenarios Available"
            });
        }
    }
    catch (e) {
        res.status(500).json({
            status: "Failed",
            message: e
        });
    }
}

var pollSpeech = async (uid_array) => {
    await wait(3000);
    var polledSpeeches = [];

    for (var i = 0; i < uid_array.length; i++) {
        polledSpeeches.push(await speakStatus(uid_array[i]));
    }

    if (polledSpeeches.filter(speech => speech.finished_at == null).length != 0) {
        //Recursively call the poll function
        pollSpeech(uid_array);
    }
    else {
        return polledSpeeches;
    }
}

function wait(milliseconds) {
    return new Promise(resolve => setTimeout(resolve, milliseconds));
}

var requestVoice = async (dialogue) => {
    
    var request = {
        method: "POST",
        headers: {
            "Content-Type":"application/json",
            "Authorization": "Basic " + Buffer.from(config.uberDuck.key + ":" + config.uberDuck.secret).toString('base64')
        },
        body: JSON.stringify({
            speech: dialogue.dialogue,
            voice: dialogue.character == "Spongebob" ? "spongebob" : dialogue.character == "Patrick" ? 'patrick' : 'squidward'
        })
    };

    var response = await fetch(config.uberDuck.speak, request);
    var jsonResponse = await response.json();

    return jsonResponse.uuid;
}

var speakStatus = async (uid) => {
    var request = {
        method: "GET",
        headers: {
            "Content-Type":"application/json",
            "Authorization": "Basic " + Buffer.from(config.uberDuck.key + ":" + config.uberDuck.secret).toString('base64')
        }
    };

    var response = await fetch(config.uberDuck.speak_status + "?uuid=" + uid, request);
    var jsonResponse = await response.json();

    return jsonResponse;
}


var processText = (text) =>  {
    //Remove all text in parentheses. This removes text such as (Queue laughter) etc
    text = text.replace(/\(.*?\)/g, '');

    //Remove everything between asterisks *. This removes actions such as *Squidward claps his hands*
    text = text.replace(/\*.*?\*/g, '');
    
    // Split the text into an array of lines
    const lines = text.split('\n');
    
    // Initialize an empty array to store the dialogue objects
    const dialogue = [];
  
    // Initialize variables to store the current character name and dialogue
    let currentCharacter = '';
    let currentDialogue = '';
  
    // Loop through each line in the text
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();
  
      // If the line is not empty
      if (line !== '') {
        // Check if the line starts with a character name followed by a colon
        const colonIndex = line.indexOf(':');
        if (colonIndex !== -1) {
          // Extract the character name and dialogue from the line
          currentCharacter = line.substring(0, colonIndex).trim();
          currentDialogue = line.substring(colonIndex + 1).trim().replace(/"/g, '');
        } else {
          // If the line does not start with a character name, append it to the current dialogue
          currentDialogue += ' ' + line.replace(/"/g, '');
        }
  
        // If the current dialogue is not empty, add it to the dialogue array
        if (currentDialogue !== '') {
          dialogue.push({
            character: currentCharacter,
            dialogue: currentDialogue
          });
        }
      }
    }
  
    // Return the dialogue array
    return dialogue;
  }
  
  

module.exports = { generateStory, suggestTopic, getScenario };