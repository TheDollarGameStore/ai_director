const express = require("express");
const req = require("express/lib/request");
const res = require("express/lib/response");
const cron = require("node-cron");

//Import functions
const storyController = require("./src/storyController");

const port = 3001;

var app = express();
app.use(express.json());

app.listen(port, () => {
    console.log(`Director is listening on port ${port}`);
})

app.get('/ping', (req, res) => {
    res.send('Pong!');
});

app.post("/story/suggest", storyController.suggestTopic);

app.get("/story/getScenario", storyController.getScenario);

generateStoryCron = () => {
    storyController.generateStory();
}

cron.schedule('*/5 * * * * *', generateStoryCron);