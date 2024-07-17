import express from "express";
import bodyParser from "body-parser";
import axios from "axios";
import NodeCache from "node-cache";
import pg from "pg";
import env from "dotenv";
import bcrypt from "bcrypt";
import passport from "passport";
import { Strategy as LocalStrategy } from "passport-local";
import session from "express-session";

const app = express();
const badgeCache = new NodeCache({ stdTTL: 3600 });
env.config();

app.use(bodyParser.urlencoded({ extended: true }));
app.use(express.static("public"));
app.use(session({
    secret: process.env.SESSION_SECRET,
    resave: false,
    saveUninitialized: false
}));
app.set("view engine", "ejs");

app.use(passport.initialize());
app.use(passport.session());

const { Pool } = pg;

const db = new Pool({
    connectionString: process.env.POSTGRES_URL,
})

db.connect()

passport.use(new LocalStrategy(async (username, password, done) => {
    try {
        const result = await db.query("SELECT * FROM users WHERE username = $1", [username]);
        if (result.rows.length === 0) {
            return done(null, false, { message: 'Invalid username or password' });
        }
        const user = result.rows[0];
        const isMatch = await bcrypt.compare(password, user.password);
        if (!isMatch) {
            return done(null, false, { message: 'Invalid username or password' });
        }
        return done(null, user);
    } catch (err) {
        return done(err);
    }
}));

passport.serializeUser((user, done) => {
    done(null, user.id);
});

passport.deserializeUser(async (id, done) => {
    try {
        const result = await db.query("SELECT * FROM users WHERE id = $1", [id]);
        if (result.rows.length === 0) {
            return done(new Error("User not found"));
        }
        done(null, result.rows[0]);
    } catch (err) {
        done(err);
    }
});

function ensureAuthenticated(req, res, next) {
    if (req.isAuthenticated()) {
        return next();
    }
    res.redirect('/login');
}

app.get("/about", (req, res) => {
    res.render("about");
});

app.get("/login", (req, res) => {
    res.render("login");
});

app.post("/login", passport.authenticate('local', {
    successRedirect: '/',
    failureRedirect: '/login',
    failureFlash: false
}));

app.get("/logout", (req, res) => {
    req.logout(function (err) {
      if (err) {
        return next(err);
      }
      res.redirect("/");
    });
});

async function fetchCompetitions(reviews) {
    for (const review of reviews) {
        const result = await db.query("SELECT name FROM competitions WHERE id = $1", [review.competition_id]);
        review.competition = result.rows[0];
    }
}

async function fetchTeamsAndBadges(reviews) {
    const teams = [...new Set(reviews.flatMap(review => [review.home, review.away]))];
    const badges = await Promise.all(teams.map(team => getTeamBadge(team)));
    return teams.reduce((acc, team, index) => ({ ...acc, [team]: badges[index] }), {});
}

async function renderIndexPage(res, reviews, teams, competitions, authenticated, team = "All Teams", competition = "All Competitions") {
    const badgeMap = await fetchTeamsAndBadges(reviews);
    res.render("index", {
        listItems: reviews,
        badges: badgeMap,
        teams,
        competitions: competitions.rows,
        curTeam: team,
        curCompetition: competition,
        authenticated // This should already be a boolean
    });
}

async function getAllCompetitions() {
    return await db.query("SELECT * FROM competitions WHERE count > 0 ORDER BY name");
}

async function handleNewCompetition(req, res, competitionName) {
    try {
        const result = await db.query("INSERT INTO competitions (name, count) VALUES ($1, $2) RETURNING id", [competitionName, 1]);
        return result.rows[0].id;
    } catch (error) {
        console.error('Error adding new competition:', error);
        res.status(500).send('Failed to add new competition');
    }
}

async function getTeamBadge(team) {
    let badge = badgeCache.get(team);

    if (!badge) {
        try {
            const response = await axios.get(`https://v3.football.api-sports.io/teams?search=${team}`, {
                headers: {
                    'x-rapidapi-key': process.env.API_KEY,
                    'x-rapidapi-host': process.env.API_HOST
                }
            });

            if (response.status === 200 && response.data.response.length > 0) {
                const teamId = response.data.response[0].team.id;
                badge = `https://media.api-sports.io/football/teams/${teamId}.png`;
                badgeCache.set(team, badge);
            } else throw new Error(`Failed to fetch badge for ${team}`);
        } catch (error) {
            console.error(`Error fetching badge for ${team}:`, error.message);
        }
    }

    return badge;
}

function formatDate(date) {
    return new Date(date).toLocaleDateString('en-US', { weekday: 'short', year: 'numeric', month: 'short', day: 'numeric' });
}

app.get("/about", (req, res) => {
    res.render("about.ejs");
});

app.get("/login", (req, res) => {
    res.render("login");
});

app.post("/login", async (req, res) => {
    const { username, password } = req.body;
});

app.get("/", async (req, res) => {
    const result = await db.query("SELECT * FROM reviews ORDER BY date DESC");
    const reviews = result.rows;

    await fetchCompetitions(reviews); 
    reviews.forEach(review => review.date = formatDate(review.date)); // Format dates

    const competitions = await getAllCompetitions(); 
    const allTeams = await db.query("SELECT DISTINCT home FROM reviews UNION SELECT DISTINCT away FROM reviews");
    const teams = [...new Set(allTeams.rows.map(team => team.home))];

    const authenticated = req.isAuthenticated(); 

    await renderIndexPage(res, reviews, teams, competitions, authenticated);
});

app.get("/add-review", ensureAuthenticated, async (req, res) => {
    const competitions = await getAllCompetitions();
    res.render("add-review", { competitions: competitions.rows });
});

app.post("/add-review", ensureAuthenticated, async (req, res) => {
    const { home, home_score, away, away_score, date, review } = req.body;
    let competitionId;
    if (req.body.competition === "new_competition") {
        competitionId = await handleNewCompetition(req, res, req.body.new_competition);
    }
    else {
        competitionId = req.body.competition;
    }

    try {
        await db.query("INSERT INTO reviews (home, home_score, away, away_score, competition_id, date, review) VALUES ($1, $2, $3, $4, $5, $6, $7)",
            [home, home_score, away, away_score, competitionId, date, review]);
        await db.query("UPDATE competitions SET count = count + 1 WHERE id = $1", [competitionId]);
        res.redirect("/");
    } catch (error) {
        console.error('Error adding new review:', error);
        res.status(500).send('Failed to add new review');
    }
});

app.get("/edit-review/:id", ensureAuthenticated, async (req, res) => {
    const reviewId = parseInt(req.params.id);
    const reviewResult = await db.query("SELECT * FROM reviews WHERE id = $1", [reviewId]);

    if (reviewResult.rows.length === 0) {
        return res.status(404).send("Review not found");
    }
    const review = reviewResult.rows[0];

    if (req.body.competition === "new_competition") {
        review.competition_id = await handleNewCompetition(req, res, req.body.new_competition);
    }
    const competitionResult = await db.query("SELECT name FROM competitions WHERE id = $1", [review.competition_id]);
    if (competitionResult.rows.length === 0) {
        return res.status(404).send("Competition not found");
    }

    review.competition = competitionResult.rows[0].name;
    const competitionsResult = await db.query("SELECT * FROM competitions order by name");
    res.render("edit-review", { result: review, competitions: competitionsResult.rows, defaultValue: review.competition });
});

app.post("/edit-review/:id", ensureAuthenticated, async (req, res) => {

    const reviewId = parseInt(req.params.id);
    let competitionId = req.body.competition;

    if (competitionId === "new_competition") {
        await db.query("UPDATE competitions SET count = count - 1 WHERE id = (SELECT competition_id FROM reviews WHERE id = $1)", [reviewId]);
        competitionId = await handleNewCompetition(req, res, req.body.new_competition);
    }
    else {
        const result = await db.query("SELECT id FROM competitions WHERE name = $1", [competitionId]);
        await db.query("UPDATE competitions SET count = count + 1 WHERE id = $1", [result.rows[0].id]);
        competitionId = result.rows[0].id;
    }

    const { home, home_score, away, away_score, date, review } = req.body;
    try {
        await db.query("UPDATE reviews SET home = $1, home_score = $2, away = $3, away_score = $4, competition_id = $5, date = $6, review = $7 WHERE id = $8",
            [home, home_score, away, away_score, competitionId, date, review, reviewId]);
        res.redirect("/");
    } catch (error) {
        console.error('Error updating review:', error);
        res.status(500).send('Failed to update review');
    }
});

app.post("/delete-review/:id", ensureAuthenticated, async (req, res) => {

    const reviewId = parseInt(req.params.id);
    await db.query("update competitions set count = count - 1 where id = (select competition_id from reviews where id = $1)", [reviewId])
    try {
        await db.query("DELETE FROM reviews WHERE id = $1", [reviewId]);
    } catch (err) {
        console.log(err);
    }
    res.redirect("/");
});

app.post("/filter-reviews", async (req, res) => {
    const competition = req.body.competition || "All Competitions";
    const team = req.body.team || "All Teams";
    const allTeams = await db.query("SELECT DISTINCT home FROM reviews UNION SELECT DISTINCT away FROM reviews");

    let query = "SELECT * FROM reviews WHERE 1=1";
    const queryParams = [];
    if (competition !== "All Competitions") {
        const comp = await db.query("SELECT id FROM competitions WHERE name = $1", [competition]);
        query += ` AND competition_id = $${queryParams.length + 1}`;
        queryParams.push(comp.rows[0].id);
    }
    if (team !== "All Teams") {
        query += queryParams.length ? ` AND (home = $${queryParams.length + 1} OR away = $${queryParams.length + 1})` : ` AND (home = $1 OR away = $1)`;
        queryParams.push(team);
    }

    query += " ORDER BY date DESC";
    const result = await db.query(query, queryParams);
    const reviews = result.rows;
    await fetchCompetitions(reviews);
    reviews.forEach(row => row.date = formatDate(row.date));

    const competitions = await getAllCompetitions();
    const teamNames = [...new Set(allTeams.rows.map(team => team.home))];

    const authenticated = req.isAuthenticated();
    await renderIndexPage(res, reviews, teamNames, competitions, authenticated, team, competition);
});


app.post('/search-reviews', async (req, res) => {
    const search = req.body.search;
    const query = "SELECT * FROM reviews WHERE home ILIKE $1 OR away ILIKE $1 OR review ILIKE $1 ORDER BY date DESC";
    const result = await db.query(query, [`%${search}%`]);
    const reviews = result.rows;
    await fetchCompetitions(reviews);
    reviews.forEach(row => row.date = formatDate(row.date));
    const competitions = await getAllCompetitions();
    await renderIndexPage(res, reviews, reviews.flatMap(review => [review.home, review.away]), competitions);
});

app.listen(process.env.PORT, () => console.log(`Server started`));