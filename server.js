const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const cors = require('cors');
const { createClient } = require('@supabase/supabase-js');
const bcrypt = require('bcryptjs');

const app = express();
const server = http.createServer(app);
const io = socketIo(server, {
    cors: {
        origin: "*",
        methods: ["GET", "POST"]
    }
});

app.use(cors());
app.use(express.json({ limit: '10mb' }));

// Supabase config
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_KEY;
const supabase = createClient(supabaseUrl, supabaseKey);

// Store active users and their groups
const activeUsers = new Map(); // username -> socketId
const userGroups = new Map(); // username -> groupId

// ==================== AUTH API ====================

// Register
app.post('/api/register', async (req, res) => {
    const { username, password, motherName, fatherName, gender } = req.body;
    
    try {
        // Check if user exists
        const { data: existing } = await supabase
            .from('users')
            .select('username')
            .eq('username', username)
            .single();
        
        if (existing) {
            return res.json({ success: false, message: "Username already exists" });
        }
        
        const hashedPassword = await bcrypt.hash(password, 10);
        
        const { error } = await supabase
            .from('users')
            .insert([{
                username,
                password: hashedPassword,
                mother_name: motherName,
                father_name: fatherName,
                gender: gender || 'male'
            }]);
        
        if (error) throw error;
        
        res.json({ success: true });
    } catch (error) {
        console.error('Register error:', error);
        res.json({ success: false, message: error.message });
    }
});

// Login
app.post('/api/login', async (req, res) => {
    const { username, password } = req.body;
    
    try {
        const { data: user, error } = await supabase
            .from('users')
            .select('*')
            .eq('username', username)
            .single();
        
        if (error || !user) {
            return res.json({ success: false, message: "User not found" });
        }
        
        const valid = await bcrypt.compare(password, user.password);
        if (!valid) {
            return res.json({ success: false, message: "Invalid password" });
        }
        
        res.json({ 
            success: true, 
            sessionId: Date.now().toString(),
            gender: user.gender 
        });
    } catch (error) {
        res.json({ success: false, message: error.message });
    }
});

// User exists check
app.get('/user-exists', async (req, res) => {
    const { username } = req.query;
    const { data, error } = await supabase
        .from('users')
        .select('username')
        .eq('username', username)
        .single();
    
    res.json({ exists: !!data });
});

// Get user gender
app.get('/api/user-gender', async (req, res) => {
    const { username } = req.query;
    const { data, error } = await supabase
        .from('users')
        .select('gender')
        .eq('username', username)
        .single();
    
    res.json({ gender: data?.gender || 'male' });
});

// Update gender
app.post('/api/update-gender', async (req, res) => {
    const { username, gender } = req.body;
    const { error } = await supabase
        .from('users')
        .update({ gender })
        .eq('username', username);
    
    if (error) {
        res.json({ success: false, message: error.message });
    } else {
        res.json({ success: true });
    }
});

// Forgot password
app.post('/api/forgot-password', async (req, res) => {
    const { username, motherName, fatherName, newPassword } = req.body;
    
    const { data: user, error } = await supabase
        .from('users')
        .select('*')
        .eq('username', username)
        .single();
    
    if (!user || user.mother_name !== motherName || user.father_name !== fatherName) {
        return res.json({ success: false, message: "Invalid details" });
    }
    
    const hashedPassword = await bcrypt.hash(newPassword, 10);
    await supabase.from('users').update({ password: hashedPassword }).eq('username', username);
    
    res.json({ success: true });
});

// ==================== PROFILE PIC ====================

app.get('/api/get-pic', async (req, res) => {
    const { username } = req.query;
    const { data, error } = await supabase
        .from('users')
        .select('profile_pic')
        .eq('username', username)
        .single();
    
    res.json({ profilePic: data?.profile_pic || null });
});

app.post('/api/upload-pic', async (req, res) => {
    const { username, imageData } = req.body;
    const { error } = await supabase
        .from('users')
        .update({ profile_pic: imageData })
        .eq('username', username);
    
    if (error) {
        res.json({ success: false });
    } else {
        // Notify friends about profile pic update
        const { data: friends } = await supabase
            .from('friends')
            .select('user1, user2')
            .or(`user1.eq.${username},user2.eq.${username}`);
        
        if (friends) {
            friends.forEach(f => {
                const friend = f.user1 === username ? f.user2 : f.user1;
                const socketId = activeUsers.get(friend);
                if (socketId) {
                    io.to(socketId).emit('profile-pic-updated', { userId: username, imageData });
                }
            });
        }
        res.json({ success: true });
    }
});

// ==================== FRIENDS API ====================

app.get('/api/friends', async (req, res) => {
    const { username } = req.query;
    const { data, error } = await supabase
        .from('friends')
        .select('user1, user2')
        .or(`user1.eq.${username},user2.eq.${username}`);
    
    const friends = (data || []).map(f => f.user1 === username ? f.user2 : f.user1);
    res.json({ friends });
});

app.get('/api/friend-requests', async (req, res) => {
    const { username } = req.query;
    const { data, error } = await supabase
        .from('friend_requests')
        .select('from_user')
        .eq('to_user', username)
        .eq('status', 'pending');
    
    res.json({ requests: (data || []).map(r => r.from_user) });
});

app.post('/api/send-friend-request', async (req, res) => {
    const { from, to } = req.body;
    
    // Check if already friends
    const { data: existingFriend } = await supabase
        .from('friends')
        .select('*')
        .or(`and(user1.eq.${from},user2.eq.${to}),and(user1.eq.${to},user2.eq.${from})`)
        .single();
    
    if (existingFriend) {
        return res.json({ success: false, message: "Already friends" });
    }
    
    // Check if request already exists
    const { data: existingRequest } = await supabase
        .from('friend_requests')
        .select('*')
        .eq('from_user', from)
        .eq('to_user', to)
        .eq('status', 'pending')
        .single();
    
    if (existingRequest) {
        return res.json({ success: false, message: "Request already sent" });
    }
    
    await supabase.from('friend_requests').insert([{ from_user: from, to_user: to }]);
    
    // Notify if online
    const toSocketId = activeUsers.get(to);
    if (toSocketId) {
        io.to(toSocketId).emit('friend-request', { from });
    }
    
    res.json({ success: true, message: "Request sent" });
});

app.post('/api/accept-friend', async (req, res) => {
    const { from, to } = req.body;
    
    await supabase.from('friend_requests').delete().eq('from_user', from).eq('to_user', to);
    await supabase.from('friends').insert([{ user1: from, user2: to }]);
    
    res.json({ success: true });
});

app.post('/api/reject-friend', async (req, res) => {
    const { from, to } = req.body;
    await supabase.from('friend_requests').delete().eq('from_user', from).eq('to_user', to);
    res.json({ success: true });
});

app.post('/api/remove-friend', async (req, res) => {
    const { user1, user2 } = req.body;
    await supabase
        .from('friends')
        .delete()
        .or(`and(user1.eq.${user1},user2.eq.${user2}),and(user1.eq.${user2},user2.eq.${user1})`);
    res.json({ success: true });
});

// ==================== PRIVATE MESSAGES API ====================

app.get('/api/private-messages', async (req, res) => {
    const { user1, user2, limit = 20, offset = 0 } = req.query;
    
    const { data, error } = await supabase
        .from('private_messages')
        .select('*')
        .or(`and(from_user.eq.${user1},to_user.eq.${user2}),and(from_user.eq.${user2},to_user.eq.${user1})`)
        .order('created_at', { ascending: false })
        .range(parseInt(offset), parseInt(offset) + parseInt(limit) - 1);
    
    const messages = (data || []).reverse();
    res.json({ messages });
});

app.post('/api/send-private-message', async (req, res) => {
    const { from, to, text, time } = req.body;
    
    await supabase.from('private_messages').insert([{
        from_user: from,
        to_user: to,
        text,
        time
    }]);
    
    res.json({ success: true });
});

// ==================== GROUP MESSAGES API ====================

app.get('/api/group-messages', async (req, res) => {
    const { groupId, limit = 25, offset = 0 } = req.query;
    
    const { data, error } = await supabase
        .from('group_messages')
        .select('*')
        .eq('group_id', groupId)
        .order('created_at', { ascending: false })
        .range(parseInt(offset), parseInt(offset) + parseInt(limit) - 1);
    
    const messages = (data || []).reverse();
    res.json({ messages });
});

// ==================== SOCKET.IO ====================

io.on('connection', (socket) => {
    console.log('User connected:', socket.id);
    
    socket.on('register-user', async ({ username }) => {
        activeUsers.set(username, socket.id);
        console.log(`${username} registered`);
        
        // Get user's groups
        const { data: groups } = await supabase
            .from('group_members')
            .select('group_id')
            .eq('username', username);
        
        if (groups) {
            groups.forEach(g => {
                userGroups.set(username, g.group_id);
                socket.join(g.group_id);
            });
        }
        
        // Send online users list to all
        const onlineList = Array.from(activeUsers.keys());
        io.emit('online-users', onlineList);
    });
    
    socket.on('create-group', async ({ userId }) => {
        const groupId = Math.random().toString(36).substring(2, 10);
        
        await supabase.from('groups').insert([{ group_id: groupId, created_by: userId }]);
        await supabase.from('group_members').insert([{ group_id: groupId, username: userId }]);
        
        userGroups.set(userId, groupId);
        socket.join(groupId);
        socket.emit('group-created', groupId);
        socket.emit('admin-status', true);
    });
    
    socket.on('join-group', async ({ groupId, userId }) => {
        const { data: group } = await supabase
            .from('groups')
            .select('group_id')
            .eq('group_id', groupId)
            .single();
        
        if (group) {
            await supabase.from('group_members').insert([{ group_id: groupId, username: userId }]);
            userGroups.set(userId, groupId);
            socket.join(groupId);
            socket.emit('joined-group', groupId);
            
            // Check if user is admin
            const isAdmin = group.created_by === userId;
            socket.emit('admin-status', isAdmin);
            
            // Send old messages
            const { data: messages } = await supabase
                .from('group_messages')
                .select('*')
                .eq('group_id', groupId)
                .order('created_at', { ascending: true })
                .limit(50);
            
            socket.emit('old-messages', messages || []);
        } else {
            socket.emit('error', 'Group not found');
        }
    });
    
    socket.on('rejoin-group', async ({ groupId, userId }) => {
        socket.join(groupId);
        userGroups.set(userId, groupId);
        
        // Send only online users, not old messages (prevents auto load)
        const onlineList = Array.from(activeUsers.keys());
        io.emit('online-users', onlineList);
    });
    
    socket.on('send-message', async ({ groupId, msg }) => {
        await supabase.from('group_messages').insert([{
            group_id: groupId,
            user: msg.user,
            text: msg.text,
            time: msg.time
        }]);
        
        io.to(groupId).emit('new-message', msg);
    });
    
    socket.on('play-video', ({ groupId, videoId }) => {
        io.to(groupId).emit('sync-video', { videoId });
    });
    
    socket.on('leave-group', async ({ groupId, userId }) => {
        await supabase.from('group_members').delete().eq('group_id', groupId).eq('username', userId);
        socket.leave(groupId);
        if (userGroups.get(userId) === groupId) {
            userGroups.delete(userId);
        }
    });
    
    socket.on('close-group', async ({ groupId, userId }) => {
        const { data: group } = await supabase.from('groups').select('created_by').eq('group_id', groupId).single();
        
        if (group && group.created_by === userId) {
            await supabase.from('group_members').delete().eq('group_id', groupId);
            await supabase.from('group_messages').delete().eq('group_id', groupId);
            await supabase.from('groups').delete().eq('group_id', groupId);
            
            io.to(groupId).emit('group-closed');
        }
    });
    
    socket.on('private-message', async ({ to, from, text, time }) => {
        const toSocketId = activeUsers.get(to);
        if (toSocketId) {
            io.to(toSocketId).emit('private-message', { from, text, time });
        }
    });
    
    socket.on('disconnect', () => {
        let disconnectedUser = null;
        for (let [user, id] of activeUsers.entries()) {
            if (id === socket.id) {
                disconnectedUser = user;
                activeUsers.delete(user);
                break;
            }
        }
        const onlineList = Array.from(activeUsers.keys());
        io.emit('online-users', onlineList);
        console.log('User disconnected:', disconnectedUser);
    });
});

// ==================== START SERVER ====================
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});
