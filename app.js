const express = require('express');
const app = express();
app.use(express.static('public'))
app.set("view engine", "twig");

app.disable("x-powered-by");

app.get("/", async(req, res) => {
    res.render("index")
}
)

app.listen(3001, () => {
    console.log("portfolio is running");
})