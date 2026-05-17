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

// Store active users
const activeUsers = new Map();
const userSockets = new Map();

// ==================== API ROUTES ====================

// Register
app.post('/api/register', async (req, res) => {
    const { username, password, motherName, fatherName, gender } = req.body;
    
    try {
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
    const { data } = await supabase
        .from('users')
        .select('username')
        .eq('username', username)
        .single();
    
    res.json({ exists: !!data });
});

// Get user gender
app.get('/api/user-gender', async (req, res) => {
    const { username } = req.query;
    const { data } = await supabase
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
    
    const { data: user } = await supabase
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

// Profile pic
app.get('/api/get-pic', async (req, res) => {
    const { username } = req.query;
    const { data } = await supabase
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
    
    res.json({ success: !error });
});

// Friends
app.get('/api/friends', async (req, res) => {
    const { username } = req.query;
    const { data } = await supabase
        .from('friends')
        .select('user1, user2')
        .or(`user1.eq.${username},user2.eq.${username}`);
    
    const friends = (data || []).map(f => f.user1 === username ? f.user2 : f.user1);
    res.json({ friends });
});

app.get('/api/friend-requests', async (req, res) => {
    const { username } = req.query;
    const { data } = await supabase
        .from('friend_requests')
        .select('from_user')
        .eq('to_user', username)
        .eq('status', 'pending');
    
    res.json({ requests: (data || []).map(r => r.from_user) });
});

app.post('/api/send-friend-request', async (req, res) => {
    const { from, to } = req.body;
    
    const { data: existingFriend } = await supabase
        .from('friends')
        .select('*')
        .or(`and(user1.eq.${from},user2.eq.${to}),and(user1.eq.${to},user2.eq.${from})`)
        .single();
    
    if (existingFriend) {
        return res.json({ success: false, message: "Already friends" });
    }
    
    await supabase.from('friend_requests').insert([{ from_user: from, to_user: to }]);
    
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

// Private messages
app.get('/api/private-messages', async (req, res) => {
    const { user1, user2, limit = 100, offset = 0 } = req.query;
    
    const { data } = await supabase
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

// Group messages
app.get('/api/group-messages', async (req, res) => {
    const { groupId, limit = 100, offset = 0 } = req.query;
    
    const { data } = await supabase
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
    console.log('Socket connected:', socket.id);
    
    socket.on('register-user', async ({ username }) => {
        activeUsers.set(username, socket.id);
        userSockets.set(socket.id, username);
        console.log(`${username} registered, online: ${activeUsers.size}`);
        
        const onlineList = Array.from(activeUsers.keys());
        io.emit('online-users', onlineList);
    });
    
    socket.on('create-group', async ({ userId }) => {
        const groupId = Math.random().toString(36).substring(2, 10).toUpperCase();
        console.log(`Creating group: ${groupId} by ${userId}`);
        
        await supabase.from('groups').insert([{ group_id: groupId, created_by: userId }]);
        await supabase.from('group_members').insert([{ group_id: groupId, username: userId }]);
        
        socket.join(groupId);
        socket.emit('group-created', groupId);
        socket.emit('admin-status', true);
        socket.data.currentGroup = groupId;
    });
    
    socket.on('join-group', async ({ groupId, userId }) => {
        console.log(`Join group request: ${userId} -> ${groupId}`);
        
        const { data: group } = await supabase
            .from('groups')
            .select('group_id, created_by')
            .eq('group_id', groupId)
            .single();
        
        if (!group) {
            socket.emit('error', 'Group not found');
            return;
        }
        
        const { data: existing } = await supabase
            .from('group_members')
            .select('*')
            .eq('group_id', groupId)
            .eq('username', userId)
            .single();
        
        if (!existing) {
            await supabase.from('group_members').insert([{ group_id: groupId, username: userId }]);
        }
        
        socket.join(groupId);
        socket.emit('joined-group', groupId);
        socket.emit('admin-status', group.created_by === userId);
        socket.data.currentGroup = groupId;
        
        const { data: messages } = await supabase
            .from('group_messages')
            .select('*')
            .eq('group_id', groupId)
            .order('created_at', { ascending: true })
            .limit(100);
        
        socket.emit('old-messages', messages || []);
        
        const onlineList = Array.from(activeUsers.keys());
        io.emit('online-users', onlineList);
    });
    
    socket.on('rejoin-group', async ({ groupId, userId }) => {
        if (groupId) {
            socket.join(groupId);
            socket.data.currentGroup = groupId;
            const onlineList = Array.from(activeUsers.keys());
            io.emit('online-users', onlineList);
        }
    });
    
    socket.on('send-message', async ({ groupId, msg }) => {
        console.log(`Send message to group ${groupId}:`, msg);
        
        await supabase.from('group_messages').insert([{
            group_id: groupId,
            username: msg.user,
            text: msg.text,
            time: msg.time
        }]);
        
        io.to(groupId).emit('new-message', msg);
    });
    
    socket.on('play-video', ({ groupId, videoId }) => {
        io.to(groupId).emit('sync-video', { videoId });
    });
    
    // ✅ FIXED: Leave group
    socket.on('leave-group', async ({ groupId, userId }) => {
        console.log(`User ${userId} leaving group ${groupId}`);
        await supabase.from('group_members').delete().eq('group_id', groupId).eq('username', userId);
        socket.leave(groupId);
        socket.emit('left-group', { groupId });
        if (socket.data.currentGroup === groupId) {
            delete socket.data.currentGroup;
        }
    });
    
    // ✅ FIXED: Close group
    socket.on('close-group', async ({ groupId, userId }) => {
        console.log(`User ${userId} trying to close group ${groupId}`);
        const { data: group } = await supabase
            .from('groups')
            .select('created_by')
            .eq('group_id', groupId)
            .single();
        
        if (group && group.created_by === userId) {
            await supabase.from('group_members').delete().eq('group_id', groupId);
            await supabase.from('group_messages').delete().eq('group_id', groupId);
            await supabase.from('groups').delete().eq('group_id', groupId);
            io.to(groupId).emit('group-closed');
            console.log(`Group ${groupId} closed by admin ${userId}`);
        } else {
            socket.emit('error', 'Not authorized to close this group');
        }
    });
    
    socket.on('private-message', async ({ to, from, text, time }) => {
        const toSocketId = activeUsers.get(to);
        if (toSocketId) {
            io.to(toSocketId).emit('private-message', { from, text, time });
        }
    });
    
    socket.on('disconnect', () => {
        const username = userSockets.get(socket.id);
        if (username) {
            activeUsers.delete(username);
            userSockets.delete(socket.id);
            console.log(`${username} disconnected`);
            
            const onlineList = Array.from(activeUsers.keys());
            io.emit('online-users', onlineList);
        }
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});
