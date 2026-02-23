import 'dotenv/config';
import express, { Request, Response, NextFunction } from 'express';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "./generated/prisma/client";

const connectionString = `${process.env.DATABASE_URL}`;
const adapter = new PrismaPg({ connectionString });
const prisma = new PrismaClient({ adapter });

const app = express();

app.use(express.json());

const JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET) {
  console.warn('JWT_SECRET is not set. Please set it in your environment for auth to work securely.');
}

type AuthRequest = Request & { userId?: string };

const authMiddleware = (req: AuthRequest, res: Response, next: NextFunction) => {
  const authHeader = req.headers['authorization'];
  if (!authHeader) {
    return res.status(401).json({ error: 'Missing Authorization header' });
  }

  const [scheme, token] = authHeader.split(' ');
  if (scheme !== 'Bearer' || !token) {
    return res.status(401).json({ error: 'Invalid Authorization header format' });
  }

  try {
    if (!JWT_SECRET) {
      return res.status(500).json({ error: 'Server auth configuration error' });
    }

    const payload = jwt.verify(token, JWT_SECRET) as { userId: string };
    req.userId = payload.userId;
    next();
  } catch (err) {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
};

app.post('/auth/register', async (req: Request, res: Response) => {
  try {
    console.log("auth/register");
    const { username, password } = req.body as { username?: string; password?: string };

    if (!username || !password) {
      return res.status(400).json({ error: 'username and password are required' });
    }

    const existing = await prisma.user.findUnique({ where: { username } });
    if (existing) {
      return res.status(409).json({ error: 'Username already taken' });
    }

    const hashed = await bcrypt.hash(password, 10);
    const user = await prisma.user.create({
      data: {
        username,
        password: hashed,
      },
      select: {
        id: true,
        username: true,
        createdAt: true,
      },
    });

    return res.status(201).json(user);
  } catch (err) {
    console.error('Error in /auth/register', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

app.post('/auth/login', async (req: Request, res: Response) => {
  try {
    const { username, password } = req.body as { username?: string; password?: string };

    if (!username || !password) {
      return res.status(400).json({ error: 'username and password are required' });
    }

    const user = await prisma.user.findUnique({ where: { username } });
    if (!user) {
      return res.status(401).json({ error: 'Invalid username or password' });
    }

    const match = await bcrypt.compare(password, user.password);
    if (!match) {
      return res.status(401).json({ error: 'Invalid username or password' });
    }

    if (!JWT_SECRET) {
      return res.status(500).json({ error: 'Server auth configuration error' });
    }

    const token = jwt.sign({ userId: user.id }, JWT_SECRET, { expiresIn: '7d' });
    return res.status(200).json({ token });
  } catch (err) {
    console.error('Error in /auth/login', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

app.post('/tasks', authMiddleware, async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.userId;
    if (!userId) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const { name, startTime } = req.body as { name?: string; startTime?: string };
    if (!name) {
      return res.status(400).json({ error: 'name is required' });
    }

    const start = startTime ? new Date(startTime) : new Date();
    if (isNaN(start.getTime())) {
      return res.status(400).json({ error: 'Invalid startTime' });
    }

    const task = await prisma.task.create({
      data: {
        name,
        startTime: start,
        userId,
      },
    });

    return res.status(201).json(task);
  } catch (err) {
    console.error('Error in POST /tasks', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

app.patch('/tasks/:id', authMiddleware, async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.userId;
    if (!userId) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const { id } = req.params;
    const { endTime, score, comment } = req.body as {
      endTime?: string;
      score?: number;
      comment?: string | null;
    };

    const existing = await prisma.task.findFirst({ where: { id, userId } });
    if (!existing) {
      return res.status(404).json({ error: 'Task not found' });
    }

    const data: {
      endTime?: Date | null;
      score?: number | null;
      comment?: string | null;
    } = {};

    if (endTime !== undefined) {
      const end = new Date(endTime);
      if (isNaN(end.getTime())) {
        return res.status(400).json({ error: 'Invalid endTime' });
      }
      if (end < existing.startTime) {
        return res.status(400).json({ error: 'endTime cannot be before startTime' });
      }
      data.endTime = end;
    }

    if (score !== undefined) {
      if (typeof score !== 'number' || score < -10 || score > 10) {
        return res.status(400).json({ error: 'score must be between -10 and 10' });
      }
      data.score = score;
    }

    if (comment !== undefined) {
      data.comment = comment === null ? null : String(comment);
    }

    const updated = await prisma.task.update({
      where: { id },
      data,
    });

    return res.status(200).json(updated);
  } catch (err) {
    console.error('Error in PATCH /tasks/:id', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

app.get('/tasks', authMiddleware, async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.userId;
    if (!userId) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const page = parseInt((req.query.page as string) || '1', 10) || 1;
    const pageSize = Math.min(
      100,
      Math.max(1, parseInt((req.query.pageSize as string) || '10', 10) || 10),
    );
    const nameFilter = (req.query.name as string) || undefined;
    const hasScore =
      req.query.hasScore === 'true'
        ? true
        : req.query.hasScore === 'false'
        ? false
        : undefined;
    const sort = (req.query.sort as string) || 'startTime_desc';

    const where: any = { userId };
    if (nameFilter) {
      where.name = { contains: nameFilter, mode: 'insensitive' };
    }
    if (hasScore === true) {
      where.score = { not: null };
    } else if (hasScore === false) {
      where.score = null;
    }

    const orderBy = (() => {
      switch (sort) {
        case 'startTime_asc':
          return { startTime: 'asc' as const };
        case 'endTime_asc':
          return { endTime: 'asc' as const };
        case 'endTime_desc':
          return { endTime: 'desc' as const };
        case 'createdAt_desc':
          return { createdAt: 'desc' as const };
        case 'startTime_desc':
        default:
          return { startTime: 'desc' as const };
      }
    })();

    const [total, items] = await Promise.all([
      prisma.task.count({ where }),
      prisma.task.findMany({
        where,
        orderBy,
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
    ]);

    return res.status(200).json({
      items,
      page,
      pageSize,
      total,
      totalPages: Math.ceil(total / pageSize),
    });
  } catch (err) {
    console.error('Error in GET /tasks', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

app.get('/tasks/:id', authMiddleware, async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.userId;
    if (!userId) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const { id } = req.params;

    const task = await prisma.task.findFirst({ where: { id, userId } });
    if (!task) {
      return res.status(404).json({ error: 'Task not found' });
    }

    return res.status(200).json(task);
  } catch (err) {
    console.error('Error in GET /tasks/:id', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

app.get('/', (req: Request, res: Response) => {
  res.json({ message: 'OK' });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
});