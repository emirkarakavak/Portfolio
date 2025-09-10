const express = require('express');
const helmet = require('helmet');
const app = express();
app.use(express.static('public'))
app.set("view engine", "twig");
app.use(helmet({ contentSecurityPolicy: false }));
app.disable("x-powered-by");
app.set('trust proxy', true);

app.get("/", async (req, res) => {
    res.render("index")
}
)

app.listen(3001, () => {
    console.log("portfolio is running");
})