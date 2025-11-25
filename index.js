const { uploadToImgBB } = require("./utils/uploadToImgBB");
const express = require("express");
const { MongoClient, ObjectId } = require("mongodb");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const cors = require("cors");
const helmet = require("helmet");
const rateLimit = require("express-rate-limit");
const axios = require("axios");
const dotenv = require("dotenv");

dotenv.config();
const app = express();
const PORT = process.env.PORT || 5000;
const MONGO_URI = process.env.MONGO_URI;
const JWT_SECRET = process.env.JWT_SECRET;
const IMGBB_API_KEY = process.env.IMGBB_API_KEY;

// MIDDLEWARES
app.use(express.json({ limit: "10mb" }));
app.use(cors());
app.use(helmet());
app.use(rateLimit({ windowMs: 15 * 60 * 1000, max: 100 }));

// MONGO CONNECTION
const client = new MongoClient(MONGO_URI);
let db;
let usersCollection;
let postsCollection;
let commentsCollection;
let storiesCollection;

client
  .connect()
  .then(() => {
    db = client.db();
    usersCollection = db.collection("users");
    postsCollection = db.collection("posts");
    commentsCollection = db.collection("comments");
    storiesCollection = db.collection("stories");
    // module.exports = app;

    // app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
  })
  .catch((err) => console.log(err));

// UTILS
const generateToken = (id) => jwt.sign({ id }, JWT_SECRET, { expiresIn: "7d" });

const protect = async (req, res, next) => {
  let token;
  if (
    req.headers.authorization &&
    req.headers.authorization.startsWith("Bearer")
  ) {
    token = req.headers.authorization.split(" ")[1];
  }
  if (!token) return res.status(401).json({ message: "Not authorized" });

  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    const user = await usersCollection.findOne({
      _id: new ObjectId(decoded.id),
    });
    if (!user) return res.status(401).json({ message: "User not found" });
    req.user = user;
    next();
  } catch {
    res.status(401).json({ message: "Token invalid" });
  }
};

app.post("/api/auth/register", async (req, res) => {
  const { firstname, lastname, email, password } = req.body;

  // console.log(firstname, lastname);
  const userExists = await usersCollection.findOne({ email });
  if (userExists)
    return res.status(400).json({ message: "User already exists" });

  const hashedPassword = await bcrypt.hash(password, 10);
  const result = await usersCollection.insertOne({
    firstname,
    lastname,
    email,
    password: hashedPassword,
  });

  const token = generateToken(result.insertedId);

  res.status(201).json({
    _id: result.insertedId,
    firstname,
    lastname,
    email,
    token,
  });
});

app.post("/api/auth/login", async (req, res) => {
  const { email, password } = req.body;

  const user = await usersCollection.findOne({ email });
  if (!user)
    return res.status(401).json({ message: "Invalid email or password" });

  const validPassword = await bcrypt.compare(password, user.password);
  if (!validPassword)
    return res.status(401).json({ message: "Invalid email or password" });

  const token = generateToken(user._id);

  res.json({
    _id: user._id,
    firstname: user.firstname,
    lastname: user.lastname,
    email: user.email,
    token,
  });
});

// USER
app.get("/api/users/:id", protect, async (req, res) => {
  const user = await usersCollection.findOne(
    { _id: new ObjectId(req.params.id) },
    { projection: { password: 0 } }
  );
  if (!user) return res.status(404).json({ message: "User not found" });
  res.json(user);
});

// POSTS
app.get("/api/posts", protect, async (req, res) => {
  try {
    const posts = await postsCollection
      .find({
        $or: [
          { privacy: { $in: ["public", null] } }, // treat null/missing as public
          { userId: req.user._id.toString(), privacy: "private" },
        ],
      })
      .sort({ createdAt: -1 })
      .toArray();

    const postsWithLikes = await Promise.all(
      posts.map(async (post) => {
        const likeUsers = await usersCollection
          .find({
            _id: { $in: (post.likes || []).map((id) => new ObjectId(id)) },
          })
          .project({ firstname: 1, lastname: 1 })
          .toArray();
        return { ...post, likeUsers };
      })
    );

    res.json(postsWithLikes);
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Failed to fetch posts" });
  }
});


app.post("/api/posts", protect, async (req, res) => {
  try {
    const { content, imageBase64, privacy } = req.body; // <-- add privacy here

    let imageUrl = "";
    if (imageBase64) {
      console.log("Uploading image...");
      imageUrl = await uploadToImgBB(imageBase64);
    }

    const post = {
      userId: req.user._id,
      posterName: `${req.user.firstname} ${req.user.lastname}`,
      content,
      image: imageUrl,
      privacy: privacy || "public", // <-- store privacy
      likes: [],
      createdAt: new Date(),
    };

    const result = await postsCollection.insertOne(post);
    res.status(201).json({ _id: result.insertedId, ...post });
  } catch (err) {
    console.error("UPLOAD ERROR:", err.response?.data || err.message);
    res.status(400).json({ message: "Upload failed", error: err.message });
  }
});

// Share a post
app.post("/api/posts/:id/share", protect, async (req, res) => {
  const originalPost = await postsCollection.findOne({
    _id: new ObjectId(req.params.id),
  });
  if (!originalPost) return res.status(404).json({ message: "Post not found" });

  const sharedPost = {
    userId: req.user._id,
    posterName: `${req.user.firstname} ${req.user.lastname}`,
    content: originalPost.content,
    image: originalPost.image,
    sharedFrom: originalPost._id,
    likes: [],
    createdAt: new Date(),
  };

  const result = await postsCollection.insertOne(sharedPost);
  res.status(201).json({ _id: result.insertedId, ...sharedPost });
});
app.get("/api/posts/:id", async (req, res) => {
  const post = await postsCollection.findOne({
    _id: new ObjectId(req.params.id),
  });
  if (!post) return res.status(404).json({ message: "Post not found" });

  const likeUsers = await usersCollection
    .find({ _id: { $in: post.likes.map((id) => new ObjectId(id)) } })
    .project({ firstname: 1, lastname: 1 })
    .toArray();

  res.json({ ...post, likeUsers });
});

// app.get("/api/posts/:id", async (req, res) => {
//   const post = await postsCollection.findOne({
//     _id: new ObjectId(req.params.id),
//   });
//   if (!post) return res.status(404).json({ message: "Post not found" });

//   const likeUsers = await usersCollection
//     .find({ _id: { $in: post.likes.map((id) => new ObjectId(id)) } })
//     .project({ firstname: 1, lastname: 1 })
//     .toArray();

//   res.json({ ...post, likeUsers });
// });

app.post("/api/comments/:postId", protect, async (req, res) => {
  const { content, parentCommentId } = req.body;
  const comment = {
    postId: req.params.postId,
    userId: req.user._id,
    content,
    likes: [],
    parentCommentId: parentCommentId || null,
    createdAt: new Date(),
  };
  const result = await commentsCollection.insertOne(comment);
  res.status(201).json({ _id: result.insertedId, ...comment });
});

app.delete("/api/posts/:id", protect, async (req, res) => {
  const post = await postsCollection.findOne({
    _id: new ObjectId(req.params.id),
  });
  if (!post) return res.status(404).json({ message: "Post not found" });
  if (post.userId.toString() !== req.user._id.toString())
    return res.status(401).json({ message: "Not authorized" });

  await postsCollection.deleteOne({ _id: new ObjectId(req.params.id) });
  res.json({ message: "Post removed" });
});

app.post("/api/posts/:id/like", protect, async (req, res) => {
  const post = await postsCollection.findOne({
    _id: new ObjectId(req.params.id),
  });
  if (!post) return res.status(404).json({ message: "Post not found" });

  const likes = post.likes || [];
  if (likes.includes(req.user._id.toString())) {
    await postsCollection.updateOne(
      { _id: new ObjectId(req.params.id) },
      { $pull: { likes: req.user._id.toString() } }
    );
  } else {
    await postsCollection.updateOne(
      { _id: new ObjectId(req.params.id) },
      { $push: { likes: req.user._id.toString() } }
    );
  }

  const updatedPost = await postsCollection.findOne({
    _id: new ObjectId(req.params.id),
  });

  const likeUsers = await usersCollection
    .find({ _id: { $in: updatedPost.likes.map((id) => new ObjectId(id)) } })
    .project({ firstname: 1, lastname: 1 })
    .toArray();

  res.json({ ...updatedPost, likeUsers });
});

app.get("/api/comments/:postId", async (req, res) => {
  const comments = await commentsCollection
    .find({ postId: req.params.postId })
    .toArray();

  const commentsWithUser = await Promise.all(
    comments.map(async (c) => {
      const user = await usersCollection.findOne(
        { _id: new ObjectId(c.userId) },
        { projection: { firstname: 1, lastname: 1 } }
      );
      return { ...c, userName: `${user.firstname} ${user.lastname}` };
    })
  );

  res.json(commentsWithUser);
});

app.post("/api/comments/:postId", protect, async (req, res) => {
  const { content, parentCommentId } = req.body;
  const comment = {
    postId: req.params.postId,
    userId: req.user._id,
    content,
    likes: [],
    parentCommentId: parentCommentId || null,
    createdAt: new Date(),
  };
  const result = await commentsCollection.insertOne(comment);
  res.status(201).json({
    _id: result.insertedId,
    ...comment,
    userName: `${req.user.firstname} ${req.user.lastname}`,
  });
});

app.post("/api/comments/:id/like", protect, async (req, res) => {
  const comment = await commentsCollection.findOne({
    _id: new ObjectId(req.params.id),
  });
  if (!comment) return res.status(404).json({ message: "Comment not found" });

  const likes = comment.likes || [];
  if (likes.includes(req.user._id.toString())) {
    await commentsCollection.updateOne(
      { _id: new ObjectId(req.params.id) },
      { $pull: { likes: req.user._id.toString() } }
    );
  } else {
    await commentsCollection.updateOne(
      { _id: new ObjectId(req.params.id) },
      { $push: { likes: req.user._id.toString() } }
    );
  }
  const updatedComment = await commentsCollection.findOne({
    _id: new ObjectId(req.params.id),
  });
  res.json(updatedComment.likes);
});

// GET all stories
app.get("/api/stories", protect, async (req, res) => {
  try {
    const stories = await db
      .collection("stories")
      .find({
        $or: [
          { privacy: { $in: ["public", null] } },
          { userId: req.user._id.toString() },
        ],
      })
      .sort({ createdAt: -1 })
      .toArray();

    const storiesWithUser = await Promise.all(
      stories.map(async (story) => {
        const user = await usersCollection.findOne(
          { _id: new ObjectId(story.userId) },
          { projection: { firstname: 1, lastname: 1 } }
        );
        return {
          ...story,
          userName: user ? `${user.firstname} ${user.lastname}` : "User",
        };
      })
    );
    res.json(storiesWithUser);

    res.json(storiesWithUser);
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Failed to fetch stories" });
  }
});

// POST create a story
app.post("/api/stories", protect, async (req, res) => {
  try {
    const { imageBase64, content, privacy } = req.body;

    let imageUrl = "";
    if (imageBase64) {
      imageUrl = await uploadToImgBB(imageBase64);
    }

    const story = {
      userId: req.user._id.toString(),
      content: content || "",
      image: imageUrl,
      privacy: privacy || "public",
      createdAt: new Date(),
    };

    const result = await storiesCollection.insertOne(story);
    res.status(201).json({ _id: result.insertedId, ...story });
  } catch (err) {
    console.error(err);
    res.status(400).json({ message: "Failed to create story" });
  }
});

//ROOT
app.get("/", (req, res) => {
  res.send("Backend is running!");
});

module.exports = app;
